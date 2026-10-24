"""Run the unmodified app with isolated SQLite and local SMTP for acceptance."""
import ipaddress
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile


runtime = Path(os.environ["DETACHYM_ACCEPTANCE_RUNTIME"]).resolve(strict=True)
if runtime.parent != Path(tempfile.gettempdir()).resolve() or not runtime.name.startswith("detachym-e2e-real-"):
    raise RuntimeError("Acceptance runtime must be a dedicated system TEMP directory")

if "--inspect" in sys.argv:
    # Only read test metadata. Do not disclose codes, passwords, or tokens.
    with sqlite3.connect(f"file:{(runtime / 'acceptance.db').as_posix()}?mode=ro", uri=True) as db:
        print(json.dumps({
            "users": [dict(zip(("id", "username", "email"), row)) for row in
                      db.execute("SELECT id, username, email FROM users ORDER BY id")],
            "codes": [dict(zip(("email", "purpose", "consumed_at", "expires_at"), row)) for row in
                      db.execute("SELECT email, purpose, consumed_at, expires_at FROM verification_codes ORDER BY id")],
        }))
    raise SystemExit(0)

os.chdir(runtime)
from acceptance_smtp import start_smtp_sink  # noqa: E402

smtp = start_smtp_sink(runtime, os.environ["DETACHYM_ACCEPTANCE_SECRET"])
os.environ.update({
    "DETACHYM_ENV_FILE": "", "DEBUG": "false",
    "DATABASE_URL": f"sqlite+aiosqlite:///{(runtime / 'acceptance.db').as_posix()}",
    "CHROMA_PERSIST_DIR": str(runtime / "chroma"), "UPLOAD_DIR": str(runtime / "uploads"),
    "DOWNLOAD_DIR": str(runtime / "downloads"), "LOG_DIR": str(runtime / "logs"),
    "SECRET_KEY": os.environ["DETACHYM_ACCEPTANCE_SECRET"],
    "SMTP_SERVER": "127.0.0.1", "SMTP_PORT": str(smtp.server_address[1]),
    "SMTP_USER": "acceptance@example.com", "SMTP_PASSWORD": os.environ["DETACHYM_ACCEPTANCE_SECRET"],
    "ZHIPU_API_KEY": "", "VOLC_AI_RTC_APP_ID": "", "VOLC_AI_RTC_APP_KEY": "",
    "VOLC_OPENAPI_AK": "", "VOLC_OPENAPI_SK": "", "VOLC_AGENT_API_KEY": "",
    "VOLC_AGENT_CHAT_COMPLETIONS_URL": "", "BACKEND_INTERNAL_API_KEY": "",
    "VOLC_VOICE_CHAT_ASR_CONFIG_JSON": "{}", "VOLC_VOICE_CHAT_TTS_CONFIG_JSON": "{}",
    "VOLC_VOICE_CHAT_LLM_CONFIG_JSON": "{}",
    "INITIAL_ADMIN_USERNAME": "", "INITIAL_ADMIN_EMAIL": "", "INITIAL_ADMIN_PASSWORD": "",
    "REMINDER_EMAIL_WORKER_ENABLED": "false", "REMINDER_RECURRENCE_WORKER_ENABLED": "true",
    "ANONYMIZED_TELEMETRY": "false", "NO_PROXY": "*", "no_proxy": "*",
})
for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(name, None)

# Fail closed on provider calls even if the parent shell has credentials.
original_getaddrinfo = socket.getaddrinfo
original_connect = socket.socket.connect


def local_host(host):
    if host in {None, "", "localhost", b"localhost"}:
        return True
    try:
        return ipaddress.ip_address(host.decode() if isinstance(host, bytes) else host).is_loopback
    except ValueError:
        return False


def isolated_getaddrinfo(host, *args, **kwargs):
    if not local_host(host):
        raise RuntimeError("Acceptance permits loopback network only")
    return original_getaddrinfo(host, *args, **kwargs)


def isolated_connect(sock, address):
    if sock.family in {socket.AF_INET, socket.AF_INET6} and not local_host(address[0]):
        raise RuntimeError("Acceptance permits loopback network only")
    return original_connect(sock, address)


socket.getaddrinfo = isolated_getaddrinfo
socket.socket.connect = isolated_connect

import uvicorn  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from app.main import app  # noqa: E402

frontend_dist = Path(os.environ["DETACHYM_ACCEPTANCE_FRONTEND_DIST"]).resolve(strict=True)
app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="acceptance-web-assets")


@app.get("/{page:path}", include_in_schema=False)
async def acceptance_web_page(page: str):
    return FileResponse(frontend_dist / "index.html", headers={
        "Content-Security-Policy": "connect-src 'self'; form-action 'self'", "Cache-Control": "no-store",
    })


sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(os.environ.get("DETACHYM_ACCEPTANCE_PORT", "0"))))
print(json.dumps({"acceptancePort": sock.getsockname()[1], "smtpPort": smtp.server_address[1],
                  "accountsSeeded": False, "externalNetwork": "blocked"}), flush=True)
server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
try:
    server.run(sockets=[sock])
finally:
    smtp.shutdown()
    smtp.server_close()
