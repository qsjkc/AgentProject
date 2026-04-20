import asyncio
from pathlib import Path
from typing import AsyncGenerator

from alembic import command
from alembic.config import Config
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import declarative_base, relationship

from app.core.config import settings
from app.core.logging import logger
from app.core.time import utc_now

Base = declarative_base()
BACKEND_ROOT = Path(__file__).resolve().parents[2]
LEGACY_APP_TABLES = {
    "users",
    "user_preferences",
    "verification_codes",
    "chat_sessions",
    "chat_messages",
    "documents",
}

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    future=True,
)

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db() -> None:
    async with engine.begin() as conn:
        dialect_name = conn.dialect.name
        table_names = await conn.run_sync(lambda sync_conn: set(inspect(sync_conn).get_table_names()))

    if dialect_name == "sqlite":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await ensure_legacy_sqlite_schema(conn)
        logger.info("SQLite schema initialized via metadata bootstrap")
        return

    if not settings.AUTO_RUN_MIGRATIONS:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.warning("AUTO_RUN_MIGRATIONS disabled; schema initialized via metadata bootstrap")
        return

    await ensure_relational_schema(table_names)


def get_alembic_config() -> Config:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    return config


async def run_alembic_command(action: str, revision: str) -> None:
    config = get_alembic_config()
    await asyncio.to_thread(getattr(command, action), config, revision)


async def ensure_relational_schema(existing_tables: set[str]) -> None:
    has_business_tables = bool(existing_tables & LEGACY_APP_TABLES)
    has_alembic_version = "alembic_version" in existing_tables

    if not has_business_tables:
        logger.info("Database is empty; applying Alembic migrations")
        await run_alembic_command("upgrade", "head")
        return

    if has_alembic_version:
        logger.info("Alembic version table detected; upgrading schema to head")
        await run_alembic_command("upgrade", "head")
        return

    logger.warning(
        "Legacy relational schema detected without alembic_version; bootstrapping missing tables and stamping head"
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await run_alembic_command("stamp", "head")


async def get_sqlite_table_columns(conn, table_name: str) -> set[str]:
    result = await conn.exec_driver_sql(f"PRAGMA table_info({table_name})")
    return {row[1] for row in result.fetchall()}


async def ensure_legacy_sqlite_schema(conn) -> None:
    if conn.dialect.name != "sqlite":
        return

    users_columns = await get_sqlite_table_columns(conn, "users")
    if "status" not in users_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'"
        )
    if "last_login_at" not in users_columns:
        await conn.exec_driver_sql("ALTER TABLE users ADD COLUMN last_login_at DATETIME")
    if users_columns:
        await conn.exec_driver_sql(
            "UPDATE users SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''"
        )

    documents_columns = await get_sqlite_table_columns(conn, "documents")
    if "updated_at" not in documents_columns:
        await conn.exec_driver_sql("ALTER TABLE documents ADD COLUMN updated_at DATETIME")
    if documents_columns:
        await conn.exec_driver_sql(
            "UPDATE documents SET updated_at = created_at WHERE updated_at IS NULL"
        )


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    is_active = Column(Boolean, nullable=False, default=True)
    is_superuser = Column(Boolean, nullable=False, default=False)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")
    documents = relationship("Document", back_populates="user", cascade="all, delete-orphan")
    preferences = relationship("UserPreference", back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserPreference(Base):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_user_preferences_user_id"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    pet_type = Column(String(20), nullable=False, default="cat")
    quick_chat_enabled = Column(Boolean, nullable=False, default=True)
    bubble_frequency = Column(Integer, nullable=False, default=120)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="preferences")


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(100), index=True, nullable=False)
    code = Column(String(6), nullable=False)
    purpose = Column(String(32), index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at = Column(DateTime, nullable=False)
    consumed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(200), default="New Chat", nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    session = relationship("ChatSession", back_populates="messages")


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_type = Column(String(50), nullable=True)
    file_size = Column(Integer, nullable=True)
    chunk_count = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="pending")
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="documents")
