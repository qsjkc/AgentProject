import asyncio
from pathlib import Path
from typing import AsyncGenerator

from alembic import command
from alembic.config import Config
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
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
    "reminders",
    "reminder_series",
    "pet_relationships",
    "pet_relationship_milestones",
    "pet_intimacy_events",
    "pet_activity_events",
    "pet_retention_events",
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
            await backfill_pet_activity_events(conn)
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
        await backfill_pet_activity_events(conn)
    await run_alembic_command("stamp", "head")


async def get_sqlite_table_columns(conn, table_name: str) -> set[str]:
    result = await conn.exec_driver_sql(f"PRAGMA table_info({table_name})")
    return {row[1] for row in result.fetchall()}


async def backfill_pet_activity_events(conn) -> None:
    await conn.exec_driver_sql(
        """
        INSERT INTO pet_activity_events (
            user_id,
            relationship_id,
            pet_type,
            action,
            idempotency_key,
            occurred_at
        )
        SELECT
            source.user_id,
            source.relationship_id,
            source.pet_type,
            source.action,
            source.idempotency_key,
            source.awarded_at
        FROM pet_intimacy_events AS source
        WHERE source.action NOT IN ('reminder_created', 'reminder_completed', 'meaningful_chat')
          AND NOT EXISTS (
              SELECT 1
              FROM pet_activity_events AS existing
              WHERE existing.user_id = source.user_id
                AND existing.idempotency_key = source.idempotency_key
          )
        """
    )


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

    relationship_columns = await get_sqlite_table_columns(conn, "pet_relationships")
    if relationship_columns and "unlocked_outfits" not in relationship_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE pet_relationships ADD COLUMN unlocked_outfits JSON NOT NULL DEFAULT '[]'"
        )
    if relationship_columns and "equipped_outfits" not in relationship_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE pet_relationships ADD COLUMN equipped_outfits JSON NOT NULL DEFAULT '{}'"
        )

    chat_message_columns = await get_sqlite_table_columns(conn, "chat_messages")
    if chat_message_columns and "pet_type" not in chat_message_columns:
        await conn.exec_driver_sql("ALTER TABLE chat_messages ADD COLUMN pet_type VARCHAR(20)")
    if chat_message_columns:
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_chat_messages_pet_daily "
            "ON chat_messages (pet_type, role, created_at)"
        )

    reminder_columns = await get_sqlite_table_columns(conn, "reminders")
    if reminder_columns and "email_enabled" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_enabled BOOLEAN NOT NULL DEFAULT 0"
        )
    if reminder_columns and "email_status" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_status VARCHAR(20) NOT NULL DEFAULT 'disabled'"
        )
    if reminder_columns and "email_sent_at" not in reminder_columns:
        await conn.exec_driver_sql("ALTER TABLE reminders ADD COLUMN email_sent_at DATETIME")
    if reminder_columns and "email_claimed_at" not in reminder_columns:
        await conn.exec_driver_sql("ALTER TABLE reminders ADD COLUMN email_claimed_at DATETIME")
    if reminder_columns and "email_claim_token" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_claim_token VARCHAR(36)"
        )
    if reminder_columns and "email_attempt_count" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_attempt_count INTEGER NOT NULL DEFAULT 0"
        )
    if reminder_columns and "email_next_attempt_at" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_next_attempt_at DATETIME"
        )
    if reminder_columns and "email_last_error" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN email_last_error VARCHAR(500)"
        )
    if reminder_columns:
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_reminders_email_delivery "
            "ON reminders (status, email_enabled, email_status, remind_at, email_next_attempt_at)"
        )
    if reminder_columns and "series_id" not in reminder_columns:
        await conn.exec_driver_sql("ALTER TABLE reminders ADD COLUMN series_id INTEGER")
    if reminder_columns and "recurrence_type" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN recurrence_type VARCHAR(20) "
            "NOT NULL DEFAULT 'once'"
        )
    if reminder_columns and "occurrence_sequence" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN occurrence_sequence INTEGER"
        )
    if reminder_columns and "creation_source" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN creation_source VARCHAR(20) "
            "NOT NULL DEFAULT 'user'"
        )
    if reminder_columns and "cancellation_source" not in reminder_columns:
        await conn.exec_driver_sql(
            "ALTER TABLE reminders ADD COLUMN cancellation_source VARCHAR(20)"
        )
    if reminder_columns:
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_reminders_series_id ON reminders (series_id)"
        )
        await conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_reminders_series_sequence "
            "ON reminders (series_id, occurrence_sequence)"
        )

    retention_event_columns = await get_sqlite_table_columns(
        conn,
        "pet_retention_events",
    )
    if retention_event_columns:
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_pet_retention_events_weekly_funnel "
            "ON pet_retention_events (pet_type, review_key, event_type, user_id)"
        )

    await backfill_pet_activity_events(conn)


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
    reminders = relationship("Reminder", back_populates="user", cascade="all, delete-orphan")
    reminder_series = relationship(
        "ReminderSeries",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    pet_relationships = relationship("PetRelationship", back_populates="user", cascade="all, delete-orphan")
    pet_intimacy_events = relationship("PetIntimacyEvent", back_populates="user", cascade="all, delete-orphan")
    pet_activity_events = relationship("PetActivityEvent", back_populates="user", cascade="all, delete-orphan")
    pet_retention_events = relationship(
        "PetRetentionEvent",
        back_populates="user",
        cascade="all, delete-orphan",
    )


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
    __table_args__ = (
        Index("ix_chat_messages_pet_daily", "pet_type", "role", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(20), nullable=False)
    pet_type = Column(String(20), nullable=True)
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


class ReminderSeries(Base):
    __tablename__ = "reminder_series"
    __table_args__ = (
        Index(
            "ix_reminder_series_materialization",
            "status",
            "next_occurrence_at",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pet_type = Column(String(20), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    source_text = Column(Text, nullable=True)
    recurrence_type = Column(String(20), nullable=False)
    timezone = Column(String(64), nullable=False)
    local_hour = Column(Integer, nullable=False)
    local_minute = Column(Integer, nullable=False)
    weekdays = Column(JSON, nullable=False, default=list)
    status = Column(String(20), nullable=False, default="active", index=True)
    email_enabled = Column(Boolean, nullable=False, default=True)
    next_occurrence_at = Column(DateTime, nullable=False, index=True)
    next_sequence = Column(Integer, nullable=False, default=2)
    last_materialized_at = Column(DateTime, nullable=True)
    skipped_occurrence_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="reminder_series")
    reminders = relationship("Reminder", back_populates="series", passive_deletes=True)


class Reminder(Base):
    __tablename__ = "reminders"
    __table_args__ = (
        UniqueConstraint(
            "series_id",
            "occurrence_sequence",
            name="uq_reminders_series_sequence",
        ),
        Index(
            "ix_reminders_email_delivery",
            "status",
            "email_enabled",
            "email_status",
            "remind_at",
            "email_next_attempt_at",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    series_id = Column(
        Integer,
        ForeignKey("reminder_series.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    pet_type = Column(String(20), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    source_text = Column(Text, nullable=True)
    remind_at = Column(DateTime, nullable=False, index=True)
    status = Column(String(20), nullable=False, default="pending", index=True)
    triggered_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    cancellation_source = Column(String(20), nullable=True)
    recurrence_type = Column(String(20), nullable=False, default="once")
    occurrence_sequence = Column(Integer, nullable=True)
    creation_source = Column(String(20), nullable=False, default="user")
    email_enabled = Column(Boolean, nullable=False, default=True)
    email_status = Column(String(20), nullable=False, default="pending")
    email_sent_at = Column(DateTime, nullable=True)
    email_claimed_at = Column(DateTime, nullable=True)
    email_claim_token = Column(String(36), nullable=True)
    email_attempt_count = Column(Integer, nullable=False, default=0)
    email_next_attempt_at = Column(DateTime, nullable=True)
    email_last_error = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="reminders")
    series = relationship("ReminderSeries", back_populates="reminders")


class PetRelationship(Base):
    __tablename__ = "pet_relationships"
    __table_args__ = (
        UniqueConstraint("user_id", "pet_type", name="uq_pet_relationships_user_pet"),
        CheckConstraint("intimacy_xp >= 0", name="ck_pet_relationships_intimacy_xp_nonnegative"),
        CheckConstraint("level >= 1 AND level <= 5", name="ck_pet_relationships_level_range"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pet_type = Column(String(20), nullable=False, index=True)
    intimacy_xp = Column(Integer, nullable=False, default=0)
    level = Column(Integer, nullable=False, default=1)
    relationship_stage = Column(String(32), nullable=False, default="new_friend")
    current_mood = Column(String(20), nullable=False, default="idle")
    unlocked_outfits = Column(JSON, nullable=False, default=list)
    equipped_outfits = Column(JSON, nullable=False, default=dict)
    last_active_at = Column(DateTime, nullable=True)
    last_greeting_at = Column(DateTime, nullable=True)
    last_level_up_at = Column(DateTime, nullable=True)
    last_weekly_review_key = Column(String(21), nullable=True)
    last_weekly_review_seen_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="pet_relationships")
    intimacy_events = relationship("PetIntimacyEvent", back_populates="relationship", cascade="all, delete-orphan")
    activity_events = relationship("PetActivityEvent", back_populates="relationship", cascade="all, delete-orphan")
    milestones = relationship(
        "PetRelationshipMilestone",
        back_populates="relationship",
        cascade="all, delete-orphan",
    )


class PetRelationshipMilestone(Base):
    __tablename__ = "pet_relationship_milestones"
    __table_args__ = (
        UniqueConstraint(
            "relationship_id",
            "level",
            name="uq_pet_relationship_milestones_relationship_level",
        ),
        UniqueConstraint(
            "relationship_id",
            "claim_token",
            name="uq_pet_relationship_milestones_relationship_claim_token",
        ),
        CheckConstraint(
            "level >= 2 AND level <= 5",
            name="ck_pet_relationship_milestones_level_range",
        ),
        Index(
            "ix_pet_relationship_milestones_pending",
            "relationship_id",
            "acknowledged_at",
            "level",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    relationship_id = Column(
        Integer,
        ForeignKey("pet_relationships.id", ondelete="CASCADE"),
        nullable=False,
    )
    level = Column(Integer, nullable=False)
    reward_outfit_id = Column(String(64), nullable=False)
    achieved_at = Column(DateTime, default=utc_now, nullable=False)
    claim_token = Column(String(36), nullable=True)
    claim_expires_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)

    relationship = relationship("PetRelationship", back_populates="milestones")


class PetIntimacyEvent(Base):
    __tablename__ = "pet_intimacy_events"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_pet_intimacy_events_user_key"),
        CheckConstraint("xp_awarded > 0", name="ck_pet_intimacy_events_xp_positive"),
        Index("ix_pet_intimacy_events_daily", "relationship_id", "awarded_at"),
        Index("ix_pet_intimacy_events_action_daily", "relationship_id", "action", "awarded_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    relationship_id = Column(
        Integer,
        ForeignKey("pet_relationships.id", ondelete="CASCADE"),
        nullable=False,
    )
    pet_type = Column(String(20), nullable=False)
    action = Column(String(32), nullable=False)
    xp_awarded = Column(Integer, nullable=False)
    idempotency_key = Column(String(128), nullable=False)
    awarded_at = Column(DateTime, default=utc_now, nullable=False)

    user = relationship("User", back_populates="pet_intimacy_events")
    relationship = relationship("PetRelationship", back_populates="intimacy_events")


class PetActivityEvent(Base):
    __tablename__ = "pet_activity_events"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_pet_activity_events_user_key"),
        Index("ix_pet_activity_events_daily", "relationship_id", "occurred_at"),
        Index(
            "ix_pet_activity_events_action_daily",
            "relationship_id",
            "action",
            "occurred_at",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    relationship_id = Column(
        Integer,
        ForeignKey("pet_relationships.id", ondelete="CASCADE"),
        nullable=False,
    )
    pet_type = Column(String(20), nullable=False)
    action = Column(String(32), nullable=False)
    idempotency_key = Column(String(128), nullable=False)
    occurred_at = Column(DateTime, default=utc_now, nullable=False)

    user = relationship("User", back_populates="pet_activity_events")
    relationship = relationship("PetRelationship", back_populates="activity_events")


class PetRetentionEvent(Base):
    __tablename__ = "pet_retention_events"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "pet_type",
            "event_type",
            "review_key",
            name="uq_pet_retention_events_funnel_step",
        ),
        CheckConstraint(
            "event_type IN ("
            "'weekly_review_generated', "
            "'weekly_review_shown', "
            "'weekly_review_seen', "
            "'weekly_review_follow_up_care', "
            "'weekly_review_follow_up_chat', "
            "'weekly_review_follow_up_reminder'"
            ")",
            name="ck_pet_retention_events_type",
        ),
        Index("ix_pet_retention_events_funnel", "event_type", "occurred_at"),
        Index(
            "ix_pet_retention_events_weekly_funnel",
            "pet_type",
            "review_key",
            "event_type",
            "user_id",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    pet_type = Column(String(20), nullable=False)
    event_type = Column(String(48), nullable=False)
    review_key = Column(String(21), nullable=False)
    occurred_at = Column(DateTime, default=utc_now, nullable=False)

    user = relationship("User", back_populates="pet_retention_events")
