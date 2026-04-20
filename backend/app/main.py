from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from app.api.router import api_router
from app.core.config import settings
from app.core.logging import logger
from app.core.security import get_password_hash
from app.models.database import User, async_session_maker, init_db


async def seed_initial_admin() -> None:
    if not (
        settings.INITIAL_ADMIN_USERNAME
        and settings.INITIAL_ADMIN_EMAIL
        and settings.INITIAL_ADMIN_PASSWORD
    ):
        return

    async with async_session_maker() as session:
        result = await session.execute(
            select(User).where(User.username == settings.INITIAL_ADMIN_USERNAME)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return

        session.add(
            User(
                username=settings.INITIAL_ADMIN_USERNAME,
                email=settings.INITIAL_ADMIN_EMAIL,
                hashed_password=get_password_hash(settings.INITIAL_ADMIN_PASSWORD),
                status="active",
                is_active=True,
                is_superuser=True,
            )
        )
        await session.commit()
        logger.info("Initial admin user created")


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Starting %s v%s", settings.APP_NAME, settings.APP_VERSION)

    Path("data").mkdir(exist_ok=True)
    Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
    Path(settings.CHROMA_PERSIST_DIR).mkdir(parents=True, exist_ok=True)
    Path(settings.DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)

    await init_db()
    await seed_initial_admin()
    logger.info("Application storage initialized")

    yield

    logger.info("Shutting down %s", settings.APP_NAME)


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.API_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_PREFIX)
app.mount(
    settings.DESKTOP_DOWNLOAD_BASE,
    StaticFiles(directory=settings.DOWNLOAD_DIR, check_dir=False),
    name="downloads",
)


@app.get("/")
async def root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running",
    }


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/health/ready")
async def readiness():
    storage_checks = {
        "uploads": Path(settings.UPLOAD_DIR).exists(),
        "chroma": Path(settings.CHROMA_PERSIST_DIR).exists(),
        "downloads": Path(settings.DOWNLOAD_DIR).exists(),
    }

    try:
        async with async_session_maker() as session:
            await session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.exception("Readiness database check failed")
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "checks": {
                    "database": f"error: {exc}",
                    "storage": storage_checks,
                },
            },
        ) from exc

    if not all(storage_checks.values()):
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "checks": {
                    "database": "ok",
                    "storage": storage_checks,
                },
            },
        )

    return {
        "status": "ready",
        "checks": {
            "database": "ok",
            "storage": storage_checks,
        },
    }
