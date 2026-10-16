"""Loopback-only SMTP capture for acceptance; never relays mail externally."""
import base64
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path
import socketserver
import ssl
import threading

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def start_smtp_sink(runtime: Path, password: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
            .sign(key, hashes.SHA256()))
    cert_path, key_path = runtime / "smtp-cert.pem", runtime / "smtp-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert_path, key_path)
    capture_path = runtime / "smtp-messages.json"
    messages = json.loads(capture_path.read_text(encoding="utf-8")) if capture_path.exists() else []
    capture_path.write_text(json.dumps(messages), encoding="utf-8")
    lock = threading.Lock()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            encrypted = authenticated = False
            recipients = []

            def reply(value):
                self.wfile.write((value + "\r\n").encode("ascii"))
                self.wfile.flush()

            reply("220 localhost acceptance SMTP")
            while line := self.rfile.readline(65536):
                text = line.decode("utf-8", errors="replace").strip()
                command, _, argument = text.partition(" ")
                command = command.upper()
                if command in {"EHLO", "HELO"}:
                    reply("250-localhost")
                    reply("250-AUTH PLAIN" if encrypted else "250-STARTTLS")
                    reply("250 SIZE 1048576")
                elif command == "STARTTLS" and not encrypted:
                    reply("220 Ready to start TLS")
                    self.connection = tls.wrap_socket(self.connection, server_side=True)
                    self.rfile = self.connection.makefile("rb")
                    self.wfile = self.connection.makefile("wb")
                    encrypted = True
                elif command == "AUTH" and encrypted:
                    method, _, credentials = argument.partition(" ")
                    if method.upper() != "PLAIN":
                        reply("504 Only PLAIN is supported")
                        continue
                    if not credentials:
                        reply("334 ")
                        credentials = self.rfile.readline().decode().strip()
                    parts = base64.b64decode(credentials).decode().split("\x00")
                    authenticated = parts[-2:] == ["acceptance@example.com", password]
                    reply("235 Authentication successful" if authenticated else "535 Authentication failed")
                elif command == "MAIL" and authenticated:
                    recipients = []
                    reply("250 Sender accepted")
                elif command == "RCPT" and authenticated:
                    recipients.append(argument.split(":", 1)[-1].strip().strip("<>"))
                    reply("250 Recipient accepted locally")
                elif command == "DATA" and authenticated and recipients:
                    reply("354 End data with <CRLF>.<CRLF>")
                    chunks = []
                    while (part := self.rfile.readline(65536)) not in {b".\r\n", b""}:
                        chunks.append(part[1:] if part.startswith(b"..") else part)
                    parsed = BytesParser(policy=policy.default).parsebytes(b"".join(chunks))
                    html = next((part.get_content() for part in parsed.walk() if part.get_content_type() == "text/html"), "")
                    with lock:
                        messages.append({"receivedAt": datetime.now(timezone.utc).isoformat(),
                                         "recipients": recipients, "subject": str(parsed["Subject"]),
                                         "html": html, "tls": encrypted, "authenticated": authenticated})
                        temporary = capture_path.with_suffix(".next")
                        temporary.write_text(json.dumps(messages, ensure_ascii=False), encoding="utf-8")
                        temporary.replace(capture_path)
                    reply("250 Captured locally; no external relay")
                elif command == "QUIT":
                    reply("221 Bye")
                    return
                elif command in {"RSET", "NOOP"}:
                    reply("250 OK")
                else:
                    reply("530 Authentication required")

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
