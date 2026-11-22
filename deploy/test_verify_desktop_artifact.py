from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from verify_desktop_artifact import (
    installer_manifest,
    main,
    verify_manifest,
    verify_public_download,
    verify_public_release,
)


class DesktopArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.version = "1.1.0-rc.2"
        self.sha = "a" * 40
        self.installer = self.directory / f"Detachym-{self.version}-x64.exe"
        self.installer.write_bytes(b"synthetic-installer")

    def manifest(self):
        return installer_manifest(self.directory, self.version, self.sha)

    def test_unique_installer_and_exact_source_can_be_verified(self):
        manifest = self.manifest()
        self.assertEqual(verify_manifest(self.directory, manifest, self.version, self.sha), manifest)
        self.assertEqual(manifest["bytes"], 19)

    def test_missing_extra_wrong_version_and_empty_installers_fail(self):
        self.installer.unlink()
        with self.assertRaises(ValueError):
            self.manifest()
        self.installer.write_bytes(b"data")
        extra = self.directory / "old.exe"
        extra.write_bytes(b"old")
        with self.assertRaises(ValueError):
            self.manifest()
        extra.unlink()
        with self.assertRaises(ValueError):
            installer_manifest(self.directory, "1.1.0-rc.3", self.sha)
        self.installer.write_bytes(b"")
        with self.assertRaises(ValueError):
            self.manifest()

    def test_bad_version_and_non_full_commit_fail(self):
        for version, sha in (("../outside", self.sha), (self.version, "main"), (self.version, "a" * 7)):
            with self.assertRaises(ValueError):
                installer_manifest(self.directory, version, sha)

    def test_tampered_file_or_manifest_cannot_be_reused(self):
        original = self.manifest()
        for key, value in (("sourceCommit", "b" * 40), ("version", "1.0.0"),
                           ("filename", "../other.exe"), ("bytes", 1), ("sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_manifest(self.directory, {**original, key: value}, self.version, self.sha)
        self.installer.write_bytes(b"tampered-installer")
        with self.assertRaises(ValueError):
            verify_manifest(self.directory, original, self.version, self.sha)

    def public_responses(self, *, available=True, version=None, size="19", ready="ready"):
        def response(payload):
            return io.BytesIO(json.dumps(payload).encode())
        head = io.BytesIO()
        head.status = 200
        head.headers = {"Content-Length": size}
        return [response({"status": ready}), response({"available": available,
                "version": version or self.version, "filename": self.installer.name}), head]

    def test_public_readiness_version_and_head_are_required(self):
        manifest = self.manifest()
        with patch("verify_desktop_artifact.urlopen", side_effect=self.public_responses()) as request:
            self.assertEqual(verify_public_release("https://detachym.top", manifest)["status"], "passed")
            self.assertEqual(request.call_args.args[0].method, "HEAD")
        for parameters in ({"ready": "failed"}, {"available": False}, {"version": "1.0.0"}, {"size": "1"}):
            with self.subTest(parameters=parameters), patch(
                "verify_desktop_artifact.urlopen", side_effect=self.public_responses(**parameters)
            ), self.assertRaises(ValueError):
                verify_public_release("https://detachym.top", manifest)

    def test_public_check_does_not_accept_http_or_url_credentials(self):
        for origin in ("http://detachym.top", "https://user:password@detachym.top", "https:///missing"):
            for verify in (verify_public_release, verify_public_download):
                with self.subTest(origin=origin, verify=verify), self.assertRaises(ValueError):
                    verify(origin, self.manifest())

    def download_response(self, body, *, status=200, headers=None, url=None):
        response = io.BytesIO(body)
        response.status = status
        response.headers = headers or {}
        response.geturl = lambda: url or f"https://detachym.top/download/{self.installer.name}"
        return response

    def test_public_download_streams_exact_bytes_and_returns_measured_evidence(self):
        chunk_bytes = 1024 * 1024
        body = b"a" * chunk_bytes + b"last chunk"
        self.installer.write_bytes(body)
        manifest = self.manifest()
        response = self.download_response(body, headers={"Content-Encoding": "identity"})
        with patch("verify_desktop_artifact.urlopen", return_value=response) as request, patch.object(
            response, "read", wraps=response.read
        ) as read:
            evidence = verify_public_download("https://detachym.top", manifest)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0].method, "GET")
        self.assertEqual(request.call_args.args[0].get_header("Accept-encoding"), "identity")
        self.assertEqual(request.call_args.kwargs["timeout"], 30)
        self.assertEqual([call.args for call in read.call_args_list], [(chunk_bytes,)] * 3)
        self.assertGreaterEqual(evidence.pop("elapsedMs"), 0)
        self.assertEqual(evidence, {"status": "passed", "origin": "https://detachym.top", **manifest})

    def test_public_download_rejects_same_length_corruption_and_wrong_body_lengths(self):
        manifest = self.manifest()
        body = self.installer.read_bytes()
        for content, error in ((b"x" + body[1:], "SHA-256"), (body[:-1], "byte count"),
                               (body + b"x", "byte count exceeds")):
            with self.subTest(error=error), patch("verify_desktop_artifact.urlopen", return_value=self.download_response(content)):
                with self.assertRaisesRegex(ValueError, error):
                    verify_public_download("https://detachym.top", manifest)

    def test_public_download_rejects_partial_redirected_encoded_or_misframed_responses(self):
        manifest = self.manifest()
        body = self.installer.read_bytes()
        for response_args, error in (
            ({"status": 206}, "HTTP 200"),
            ({"url": f"http://detachym.top/download/{self.installer.name}"}, "exact HTTPS"),
            ({"url": "https://detachym.top/download/other.exe"}, "exact HTTPS"),
            ({"headers": {"Content-Encoding": "gzip"}}, "Content-Encoding"),
            ({"headers": {"Content-Length": "100"}}, "Content-Length"),
        ):
            response = self.download_response(body, **response_args)
            with self.subTest(response_args=response_args), patch("verify_desktop_artifact.urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, error):
                    verify_public_download("https://detachym.top", manifest)

    def test_public_download_cli_requires_verified_manifest_and_uses_only_get(self):
        package = self.directory / "package.json"
        manifest = self.directory / "desktop-release.json"
        args = ["verify_desktop_artifact.py", "--directory", str(self.directory), "--package", str(package),
                "--source-commit", self.sha, "--manifest", str(manifest), "--verify-public-download"]
        public_args = ["--public-base-url", "https://detachym.top"]
        for extra in (["--verify"], public_args):
            with self.subTest(extra=extra), patch("sys.argv", args + extra):
                with self.assertRaisesRegex(ValueError, "requires --verify and --public-base-url"):
                    main()

        package.write_text(json.dumps({"version": self.version}), encoding="utf-8")
        manifest.write_text(json.dumps(self.manifest()), encoding="utf-8")
        response = self.download_response(self.installer.read_bytes())
        with patch("sys.argv", args + public_args + ["--verify"]), patch(
            "verify_desktop_artifact.urlopen", return_value=response
        ) as request, redirect_stdout(io.StringIO()) as output:
            main()
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0].method, "GET")
        self.assertEqual(json.loads(output.getvalue())["sha256"], self.manifest()["sha256"])


if __name__ == "__main__":
    unittest.main()
