from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import UserPreference


def default_preferences_insert(user_id: int, dialect: str):
    if dialect == "postgresql":
        insert = postgres_insert
    elif dialect == "sqlite":
        insert = sqlite_insert
    else:
        raise ValueError(f"Unsupported preference database dialect: {dialect}")
    # Specify the product default even on existing SQLite tables whose schema
    # is bootstrapped without applying PostgreSQL's default-only migration.
    return insert(UserPreference).values(user_id=user_id, pet_type="pig").on_conflict_do_nothing(
        index_elements=[UserPreference.user_id]
    )


async def get_or_create_preferences(user_id: int, db: AsyncSession) -> tuple[UserPreference, bool]:
    """Return preferences and whether the caller must finish a write transaction.

    A competing transaction may create the row first, so the boolean describes
    a write attempt, not creation ownership. Commit and rollback remain with
    the caller, including registration and admin account updates.
    """
    query = select(UserPreference).where(UserPreference.user_id == user_id)
    preferences = (await db.execute(query)).scalar_one_or_none()
    if preferences is not None:
        return preferences, False

    await db.execute(default_preferences_insert(user_id, db.get_bind().dialect.name))
    # A separate SELECT gets a new PostgreSQL READ COMMITTED snapshot after
    # ON CONFLICT waits for the competing transaction's commit.
    preferences = (await db.execute(query)).scalar_one()
    return preferences, True
