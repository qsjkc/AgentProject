"""Exercise the checked-in routing with nginx on PATH or NGINX_BINARY.

Only a temporary prefix and loopback ports are used. Production certificates,
upstreams and listeners are replaced; location blocks are tested unchanged.
"""

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


NGINX_BINARY = os.environ.get("NGINX_BINARY") or shutil.which("nginx")
PAGE = b"<!doctype html><title>Portal route fixture</title>"
INSTALLER = b"isolated-installer-fixture"
ASSETS = {
    "app-a1b2c3d4.js": (b'export const ready = true;', "application/javascript"),
    "app-e5f6a7b8.css": (b"body { color: black; }", "text/css"),
    "logo-c9d0e1f2.png": (b"\x89PNG\r\n\x1a\nfixture", "image/png"),
}


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@unittest.skipUnless(NGINX_BINARY, "nginx is required; set NGINX_BINARY to its executable")
class NginxRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="agentproject-nginx-routes-")
        cls.prefix = Path(cls.temporary.name).resolve()
        if (
            cls.prefix.parent != Path(tempfile.gettempdir()).resolve()
            or not cls.prefix.name.startswith("agentproject-nginx-routes-")
        ):
            raise RuntimeError("Unexpected temporary nginx prefix")
        cls.addClassCleanup(cls.temporary.cleanup)
        (cls.prefix / "logs").mkdir()
        (cls.prefix / "temp").mkdir()
        html = cls.prefix / "html"
        downloads = html / "download"
        downloads.mkdir(parents=True)
        (html / "index.html").write_bytes(PAGE)
        (downloads / "sample.exe").write_bytes(INSTALLER)
        assets = html / "assets"
        assets.mkdir()
        for name, (content, _) in ASSETS.items():
            (assets / name).write_bytes(content)
        cls.ports = [free_port(), free_port()]
        while cls.ports[0] == cls.ports[1]:
            cls.ports[1] = free_port()

        cls.upstream_requests = []

        class MockBackend(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                cls.upstream_requests.append((self.path, dict(self.headers), body))
                self.send_response(200)
                self.send_header("Content-Length", "11")
                self.end_headers()
                self.wfile.write(b"api-fixture")

            do_GET = do_POST

            def log_message(self, *_):
                pass

        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), MockBackend)
        cls.backend_thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.backend_thread.start()
        cls.addClassCleanup(cls.stop_backend)
        source = Path(__file__).with_name("nginx.conf").read_text(encoding="utf-8")
        source = source.replace("listen 443 ssl http2;", f"listen 127.0.0.1:{cls.ports[0]};")
        source = source.replace("listen 80;", f"listen 127.0.0.1:{cls.ports[1]};")
        source = re.sub(r"^\s*ssl_\w+\s+[^;]+;", "", source, flags=re.MULTILINE)
        source = source.replace("server backend:5000;", f"server 127.0.0.1:{cls.backend.server_port};")
        source = source.replace("server agentproject-agent-server:8000;", "server 127.0.0.1:9;")
        source = source.replace("root /usr/share/nginx/html;", f'root "{html.as_posix()}";')
        source = source.replace(
            "alias /usr/share/nginx/html/download/;", f'alias "{downloads.as_posix()}/";'
        )
        configuration = (
            "daemon off;\nmaster_process off;\npid logs/nginx.pid;\n"
            "error_log logs/error.log;\nevents { worker_connections 64; }\n"
            "http { access_log off; default_type application/octet-stream;\n"
            "types { text/html html; application/javascript js; text/css css; image/png png; }\n"
            + source + "\n}\n"
        )
        (cls.prefix / "nginx.conf").write_text(configuration, encoding="utf-8")
        cls.command = [str(NGINX_BINARY), "-p", cls.prefix.as_posix() + "/", "-c", "nginx.conf"]
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        checked = subprocess.run(cls.command + ["-t"], capture_output=True, timeout=10, **options)
        if checked.returncode:
            raise RuntimeError(checked.stderr.decode(errors="replace"))
        cls.process = subprocess.Popen(
            cls.command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options
        )
        cls.addClassCleanup(cls.stop_nginx)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                for port in cls.ports:
                    cls.request(port, "/")
                return
            except OSError:
                if cls.process.poll() is not None:
                    raise RuntimeError((cls.prefix / "logs/error.log").read_text())
                time.sleep(0.05)
        raise TimeoutError("isolated nginx did not start")

    @classmethod
    def stop_backend(cls):
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.backend_thread.join(timeout=5)

    @classmethod
    def stop_nginx(cls):
        if cls.process.poll() is None:
            options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            try:
                subprocess.run(cls.command + ["-s", "quit"], capture_output=True, timeout=5, **options)
                cls.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.process.terminate()
                cls.process.wait(timeout=5)

    @staticmethod
    def request(port, path, *, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            connection.request(method, path, headers=headers or {}, body=body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_auth_endpoints_share_limit_and_keep_proxy_behavior(self):
        for port in self.ports:
            for endpoint in ("forgot-password", "reset-password"):
                path = f"/api/v1/auth/{endpoint}?from=portal"
                payload = b'{"email":"isolated@example.test"}'
                status, _, body = self.request(
                    port, path, method="POST", body=payload, headers={"Content-Type": "application/json"}
                )
                self.assertEqual((status, body), (200, b"api-fixture"))
                forwarded_path, forwarded_headers, forwarded_body = self.upstream_requests[-1]
                self.assertEqual((forwarded_path, forwarded_body), (path, payload))
                self.assertEqual(forwarded_headers["Host"], "127.0.0.1")
                self.assertEqual(forwarded_headers["X-Real-IP"], "127.0.0.1")
                self.assertEqual(forwarded_headers["X-Forwarded-For"], "127.0.0.1")
                self.assertEqual(forwarded_headers["X-Forwarded-Proto"], "http")

        for _ in range(40):
            status, _, _ = self.request(self.ports[0], "/api/v1/auth/login", method="POST")
            if status == 429:
                break
        self.assertEqual(status, 429, "the shared IP bucket must reject excessive requests")
        forwarded_count = len(self.upstream_requests)
        for port in self.ports:
            for endpoint in ("login", "register", "send-verification-code", "forgot-password", "reset-password"):
                with self.subTest(port=port, endpoint=endpoint):
                    status, headers, _ = self.request(port, f"/api/v1/auth/{endpoint}?retry=1", method="POST")
                    self.assertEqual(status, 429)
                    self.assertEqual(headers["Retry-After"], "70")
        self.assertEqual(len(self.upstream_requests), forwarded_count, "rejected requests must not reach the backend")
        for port in self.ports:
            status, headers, body = self.request(port, "/api/v1/auth/me")
            self.assertEqual((status, body), (200, b"api-fixture"))
            self.assertNotIn("Retry-After", headers)
            self.assertNotIn("Cache-Control", headers)

    def test_download_page_and_deep_links_return_portal(self):
        for port in self.ports:
            for path in ("/", "/index.html", "/download", "/download?from=account", "/account", "/unknown-page"):
                with self.subTest(port=port, path=path):
                    status, headers, body = self.request(port, path)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Content-Type"], "text/html")
                    self.assertEqual(body, PAGE)
                    self.assertEqual(headers.get("Cache-Control"), "no-cache")
                    self.assertNotIn("Expires", headers)
                    status, head_headers, body = self.request(port, path, method="HEAD")
                    self.assertEqual((status, body), (200, b""))
                    self.assertEqual(head_headers.get("Cache-Control"), "no-cache")
                    status, conditional_headers, body = self.request(
                        port, path, headers={"If-None-Match": headers["ETag"]}
                    )
                    self.assertEqual((status, body), (304, b""))
                    self.assertEqual(conditional_headers.get("Cache-Control"), "no-cache")

    def test_hashed_assets_have_correct_mime_and_immutable_cache(self):
        for port in self.ports:
            for name, (content, mime_type) in ASSETS.items():
                path = f"/assets/{name}?version=fixture"
                with self.subTest(port=port, path=path):
                    status, headers, body = self.request(port, path)
                    self.assertEqual((status, body), (200, content))
                    self.assertEqual(headers["Content-Type"], mime_type)
                    self.assertEqual(headers.get("Cache-Control"), "public, max-age=31536000, immutable")
                    status, head_headers, body = self.request(port, path, method="HEAD")
                    self.assertEqual((status, body), (200, b""))
                    self.assertEqual(head_headers["Content-Type"], mime_type)
                    self.assertEqual(int(head_headers["Content-Length"]), len(content))
                    status, conditional_headers, body = self.request(
                        port, path, headers={"If-None-Match": headers["ETag"]}
                    )
                    self.assertEqual((status, body), (304, b""))
                    self.assertEqual(conditional_headers.get("Cache-Control"), headers["Cache-Control"])

    def test_missing_old_assets_return_404_without_portal_or_immutable_cache(self):
        for port in self.ports:
            for path in ("/assets/old-hash.js", "/assets/old-hash.css?version=old", "/assets/old-logo.png"):
                with self.subTest(port=port, path=path):
                    status, headers, body = self.request(port, path)
                    self.assertEqual(status, 404)
                    self.assertNotEqual(body, PAGE)
                    self.assertNotIn("immutable", headers.get("Cache-Control", ""))
                    self.assertNotIn("max-age=31536000", headers.get("Cache-Control", ""))
                    status, _, body = self.request(port, path, method="HEAD")
                    self.assertEqual((status, body), (404, b""))

    def test_trailing_slash_redirect_preserves_query(self):
        for port in self.ports:
            for query in ("", "?from=account&next=%2Faccount"):
                with self.subTest(port=port, query=query):
                    status, headers, _ = self.request(port, "/download/" + query)
                    self.assertEqual(status, 308)
                    self.assertEqual(headers["Location"], f"http://127.0.0.1:{port}/download{query}")

    def test_installers_are_files_and_missing_installers_are_404(self):
        for port in self.ports:
            with self.subTest(port=port):
                status, headers, body = self.request(port, "/download/sample.exe?source=portal")
                self.assertEqual((status, body), (200, INSTALLER))
                self.assertEqual(headers["Content-Type"], "application/octet-stream")
                self.assertEqual(headers.get("Cache-Control"), "public, max-age=300")
                status, headers, body = self.request(port, "/download/sample.exe", method="HEAD")
                self.assertEqual((status, body), (200, b""))
                self.assertEqual(int(headers["Content-Length"]), len(INSTALLER))
                status, _, body = self.request(port, "/download/sample.exe", headers={"Range": "bytes=0-3"})
                self.assertEqual((status, body), (206, INSTALLER[:4]))
                for path in ("/download/missing.exe", "/download/missing.exe?source=portal", "/download/missing/"):
                    status, _, body = self.request(port, path)
                    self.assertEqual(status, 404)
                    self.assertNotEqual(body, PAGE)


if __name__ == "__main__":
    unittest.main()
