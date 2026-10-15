"""New accounts meet the pig while existing, explicit choices stay unchanged."""
from datetime import timedelta
from io import StringIO
from pathlib import Path
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import select, text

from app.core.security import create_access_token
from app.core.time import utc_now
from app.main import app
from app.models.database import User, UserPreference, VerificationCode, async_session_maker


@pytest.fixture
async def defaults_client():
    # conftest selects temporary storage and disables external services first.
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client


async def create_account(*, pet_type=None, is_superuser=False):
    name = "pig-default-" + uuid4().hex[:12]
    async with async_session_maker() as db:
        user = User(
            username=name, email=name + "@example.com", hashed_password="unused",
            is_superuser=is_superuser,
        )
        db.add(user)
        await db.flush()
        if pet_type is not None:
            db.add(UserPreference(
                user_id=user.id, pet_type=pet_type, quick_chat_enabled=False, bubble_frequency=777,
            ))
        await db.commit()
        token = create_access_token({"sub": str(user.id), "username": user.username})
        return user, {"Authorization": "Bearer " + token}


def preference_values(preferences):
    return {name: preferences[name] for name in ("pet_type", "quick_chat_enabled", "bubble_frequency")}


async def test_registration_login_profile_and_preferences_share_the_pig_default(defaults_client):
    name = "registered-pig-" + uuid4().hex[:12]
    email = name + "@example.com"
    async with async_session_maker() as db:
        db.add(VerificationCode(
            email=email, code="123456", purpose="register", expires_at=utc_now() + timedelta(minutes=5),
        ))
        await db.commit()
    registered = await defaults_client.post("/api/v1/auth/register", json={
        "username": name, "email": email, "password": "Password123!", "verification_code": "123456",
    })
    assert registered.status_code == 200
    expected = registered.json()["preferences"]
    assert preference_values(expected) == {
        "pet_type": "pig", "quick_chat_enabled": True, "bubble_frequency": 120,
    }
    logged_in = await defaults_client.post("/api/v1/auth/login", data={
        "username": name, "password": "Password123!",
    })
    assert logged_in.status_code == 200
    headers = {"Authorization": "Bearer " + logged_in.json()["access_token"]}
    me = await defaults_client.get("/api/v1/auth/me", headers=headers)
    preferences = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    assert me.status_code == preferences.status_code == 200
    assert me.json()["preferences"] == preferences.json() == expected


async def test_admin_created_account_also_starts_with_pig(defaults_client):
    _, headers = await create_account(is_superuser=True)
    name = "admin-created-pig-" + uuid4().hex[:12]
    created = await defaults_client.post("/api/v1/admin/users", headers=headers, json={
        "username": name, "email": name + "@example.com", "password": "Password123!",
        "status": "active", "is_superuser": False,
    })
    assert created.status_code == 201
    assert preference_values(created.json()["preferences"]) == {
        "pet_type": "pig", "quick_chat_enabled": True, "bubble_frequency": 120,
    }


@pytest.mark.parametrize("pet_type", ["cat", "dog", "pig"])
async def test_profile_reads_and_admin_edits_preserve_existing_preferences(defaults_client, pet_type):
    user, headers = await create_account(pet_type=pet_type)
    _, admin_headers = await create_account(is_superuser=True)
    before = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    me = await defaults_client.get("/api/v1/auth/me", headers=headers)
    updated = await defaults_client.put(f"/api/v1/admin/users/{user.id}", headers=admin_headers, json={
        "username": user.username, "email": user.email, "status": "active", "is_superuser": False,
    })
    after = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    assert before.status_code == me.status_code == updated.status_code == after.status_code == 200
    assert preference_values(before.json()) == {
        "pet_type": pet_type, "quick_chat_enabled": False, "bubble_frequency": 777,
    }
    assert before.json() == me.json()["preferences"] == updated.json()["preferences"] == after.json()


@pytest.mark.parametrize("pet_type", ["cat", "dog", "pig"])
@pytest.mark.parametrize("update", [{}, {"bubble_frequency": 180}, {"quick_chat_enabled": True}, {"pet_type": "dog"}])
async def test_partial_preference_updates_preserve_unspecified_choices(defaults_client, pet_type, update):
    _, headers = await create_account(pet_type=pet_type)
    before = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    expected = preference_values(before.json()) | update
    result = await defaults_client.put("/api/v1/users/me/preferences", headers=headers, json=update)
    assert result.status_code == 200
    assert preference_values(result.json()) == expected
    after = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    assert after.json() == result.json()
    if not update:
        assert after.json() == before.json()


@pytest.mark.parametrize("field", ["pet_type", "quick_chat_enabled", "bubble_frequency"])
async def test_explicit_null_is_rejected_without_erasing_preferences(defaults_client, field):
    _, headers = await create_account(pet_type="pig")
    before = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    response = await defaults_client.put("/api/v1/users/me/preferences", headers=headers, json={field: None})
    assert response.status_code == 422
    after = await defaults_client.get("/api/v1/users/me/preferences", headers=headers)
    assert after.json() == before.json()


@pytest.mark.parametrize("path", ["orm", "database-default"])
async def test_new_sqlite_preferences_default_to_pig_at_both_layers(defaults_client, path):
    user, _ = await create_account()
    async with async_session_maker() as db:
        if path == "orm":
            db.add(UserPreference(user_id=user.id))
        else:
            await db.execute(text(
                "INSERT INTO user_preferences (user_id, quick_chat_enabled, bubble_frequency, created_at, updated_at) "
                "VALUES (:user_id, :enabled, :frequency, :now, :now)"
            ), {"user_id": user.id, "enabled": True, "frequency": 120, "now": utc_now()})
        await db.commit()
    async with async_session_maker() as db:
        preferences = (await db.execute(select(UserPreference).where(UserPreference.user_id == user.id))).scalar_one()
        assert preferences.pet_type == "pig"


@pytest.mark.parametrize("direction,default", [("upgrade", "pig"), ("downgrade", "cat")])
def test_postgresql_migration_only_changes_the_future_default(direction, default):
    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
    revision = scripts.get_revision("015")
    assert revision.down_revision == "014"
    assert scripts.get_current_head() == revision.revision
    output = StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output})
    with Operations.context(context):
        getattr(revision.module, direction)()
    statements = [statement.strip() for statement in output.getvalue().split(";") if statement.strip()]
    # The complete emitted migration contains no historical-row DML or rebuild.
    assert statements == [f"ALTER TABLE user_preferences ALTER COLUMN pet_type SET DEFAULT '{default}'"]
