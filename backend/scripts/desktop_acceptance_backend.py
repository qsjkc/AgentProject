"""Run the real app with disposable SQLite data for desktop acceptance only."""
import json
import os
from pathlib import Path
import socket
import tempfile


runtime = Path(os.environ["DETACHYM_ACCEPTANCE_RUNTIME"]).resolve(strict=True)
if runtime.parent != Path(tempfile.gettempdir()).resolve() or not runtime.name.startswith("detachym-e2e-real-"):
    raise RuntimeError("Acceptance runtime must be a dedicated system TEMP directory")
os.chdir(runtime)  # Never load the developer's backend/.env.
os.environ.update({
    "DATABASE_URL": f"sqlite+aiosqlite:///{(runtime / 'acceptance.db').as_posix()}",
    "CHROMA_PERSIST_DIR": str(runtime / "chroma"),
    "UPLOAD_DIR": str(runtime / "uploads"),
    "DOWNLOAD_DIR": str(runtime / "downloads"),
    "SECRET_KEY": os.environ["DETACHYM_ACCEPTANCE_SECRET"],
    "SMTP_USER": "", "SMTP_PASSWORD": "", "ZHIPU_API_KEY": "",
    "VOLC_AI_RTC_APP_ID": "", "VOLC_AI_RTC_APP_KEY": "",
    "VOLC_OPENAPI_AK": "", "VOLC_OPENAPI_SK": "",
    "INITIAL_ADMIN_USERNAME": "", "INITIAL_ADMIN_EMAIL": "", "INITIAL_ADMIN_PASSWORD": "",
    "REMINDER_EMAIL_WORKER_ENABLED": "false",
    "REMINDER_RECURRENCE_WORKER_ENABLED": "true",
    "ANONYMIZED_TELEMETRY": "false",
})

from contextlib import asynccontextmanager  # noqa: E402
import uvicorn  # noqa: E402
from app.main import app  # noqa: E402
from app.core.security import get_password_hash  # noqa: E402
from app.models.database import User, async_session_maker  # noqa: E402

original_lifespan = app.router.lifespan_context


@asynccontextmanager
async def acceptance_lifespan(application):
    async with original_lifespan(application):
        async with async_session_maker() as session:
            for user_id, suffix in [(101, "a"), (202, "b")]:
                if await session.get(User, user_id) is None:
                    session.add(User(
                        id=user_id, username=f"accept-{suffix}", email=f"accept-{suffix}@example.com",
                        hashed_password=get_password_hash(os.environ["DETACHYM_ACCEPTANCE_PASSWORD"]),
                        status="active", is_active=True, is_superuser=False,
                    ))
            await session.commit()
        yield


app.router.lifespan_context = acceptance_lifespan
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(os.environ.get("DETACHYM_ACCEPTANCE_PORT", "0"))))
print(json.dumps({"acceptancePort": sock.getsockname()[1]}), flush=True)
server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
server.run(sockets=[sock])
