import asyncio
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1 import admin, auth
from app.core.security import create_access_token, get_password_hash
from app.main import app
from app.models.database import User, UserPreference, async_session_maker
from app.services.user_preferences import default_preferences_insert, get_or_create_preferences


@pytest.fixture
async def preference_client():
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test"
        ) as client:
            yield client


async def user_without_preferences():
    name = "first-preferences-" + uuid4().hex[:8]
    async with async_session_maker() as db:
        user = User(username=name, email=name + "@example.com", hashed_password=get_password_hash("Password123!"))
        db.add(user)
        await db.commit()
        return user


def synchronize_missing_reads(monkeypatch, path):
    barrier = asyncio.Barrier(2)
    if path == "/api/v1/auth/me":
        original = auth.create_default_preferences

        async def create_after_both_read_missing(*args, **kwargs):
            await asyncio.wait_for(barrier.wait(), timeout=5)
            return await original(*args, **kwargs)

        monkeypatch.setattr(auth, "create_default_preferences", create_after_both_read_missing)
    else:
        original = AsyncSession.execute
        arrivals = 0

        async def execute_after_both_read_missing(self, statement, *args, **kwargs):
            nonlocal arrivals
            result = await original(self, statement, *args, **kwargs)
            entities = [description.get("entity") for description in getattr(statement, "column_descriptions", [])]
            if getattr(statement, "is_select", False) and UserPreference in entities and arrivals < 2:
                arrivals += 1
                await asyncio.wait_for(barrier.wait(), timeout=5)
            return result

        monkeypatch.setattr(AsyncSession, "execute", execute_after_both_read_missing)


@pytest.mark.parametrize("path", ["/api/v1/auth/me", "/api/v1/users/me/preferences"])
async def test_simultaneous_first_reads_create_one_preference(preference_client, monkeypatch, path):
    user = await user_without_preferences()
    token = create_access_token({"sub": str(user.id), "username": user.username})
    synchronize_missing_reads(monkeypatch, path)
    responses = await asyncio.gather(*[
        preference_client.get(path, headers={"Authorization": f"Bearer {token}"}) for _ in range(2)
    ])
    assert [response.status_code for response in responses] == [200, 200]
    returned = [response.json()["preferences"] if path.endswith("/auth/me") else response.json() for response in responses]
    assert returned[0]["id"] == returned[1]["id"]
    assert returned[0]["pet_type"] == returned[1]["pet_type"] == "pig"
    async with async_session_maker() as db:
        records = (await db.execute(select(UserPreference).where(UserPreference.user_id == user.id))).scalars().all()
        assert len(records) == 1


async def test_profile_and_preference_routes_initialize_the_same_record(preference_client, monkeypatch):
    user = await user_without_preferences()
    token = create_access_token({"sub": str(user.id), "username": user.username})
    synchronize_missing_reads(monkeypatch, "/shared-helper")
    profile, preferences = await asyncio.gather(*[
        preference_client.get(path, headers={"Authorization": f"Bearer {token}"})
        for path in ("/api/v1/auth/me", "/api/v1/users/me/preferences")
    ])
    assert [profile.status_code, preferences.status_code] == [200, 200]
    assert profile.json()["preferences"] == preferences.json()
    assert preferences.json()["pet_type"] == "pig"


@pytest.mark.parametrize("creator", [auth.create_default_preferences, admin.ensure_user_preferences])
async def test_registration_and_admin_helpers_tolerate_competing_creation(preference_client, monkeypatch, creator):
    user = await user_without_preferences()
    synchronize_missing_reads(monkeypatch, "/shared-helper")

    async def create_and_commit():
        async with async_session_maker() as db:
            preferences = await creator(user.id, db)
            await db.commit()
            return preferences.id

    ids = await asyncio.gather(create_and_commit(), create_and_commit())
    assert ids[0] == ids[1]
    async with async_session_maker() as db:
        records = (await db.execute(select(UserPreference).where(UserPreference.user_id == user.id))).scalars().all()
        assert len(records) == 1
        assert records[0].pet_type == "pig"


@pytest.mark.parametrize("creator", [auth.create_default_preferences, admin.ensure_user_preferences])
@pytest.mark.parametrize("new_user", [False, True])
async def test_helper_does_not_commit_parent_transaction(preference_client, creator, new_user):
    user = None if new_user else await user_without_preferences()
    async with async_session_maker() as db:
        if new_user:
            name = "rollback-preferences-" + uuid4().hex[:8]
            user = User(username=name, email=name + "@example.com", hashed_password="not-a-login-fixture")
            db.add(user)
            await db.flush()
        else:
            user = await db.get(User, user.id)
        user_id = user.id
        original_name = user.username
        user.username = original_name + "-edited"
        preferences = await creator(user_id, db)
        assert preferences.user_id == user_id
        assert preferences.pet_type == "pig"
        assert db.in_transaction()
        await db.rollback()

    async with async_session_maker() as db:
        assert (await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))).scalar_one_or_none() is None
        stored_user = await db.get(User, user_id)
        if new_user:
            assert stored_user is None
        else:
            assert stored_user.username == original_name


async def test_existing_preferences_are_preserved_without_committing_pending_edits(preference_client):
    user = await user_without_preferences()
    async with async_session_maker() as db:
        db.add(UserPreference(user_id=user.id, pet_type="dog", quick_chat_enabled=False, bubble_frequency=900))
        await db.commit()
    async with async_session_maker() as db:
        current_user = await db.get(User, user.id)
        current_user.username += "-pending"
        preferences, write_attempted = await get_or_create_preferences(user.id, db)
        assert write_attempted is False
        assert (preferences.pet_type, preferences.quick_chat_enabled, preferences.bubble_frequency) == ("dog", False, 900)
        await db.rollback()
    async with async_session_maker() as db:
        assert (await db.get(User, user.id)).username == user.username


@pytest.mark.parametrize("pet_type", ["cat", "dog", "pig"])
async def test_concurrent_first_update_keeps_custom_preferences(preference_client, monkeypatch, pet_type):
    user = await user_without_preferences()
    token = create_access_token({"sub": str(user.id), "username": user.username})
    headers = {"Authorization": f"Bearer {token}"}
    synchronize_missing_reads(monkeypatch, "/shared-helper")
    read, update = await asyncio.gather(
        preference_client.get("/api/v1/auth/me", headers=headers),
        preference_client.put("/api/v1/users/me/preferences", headers=headers, json={
            "pet_type": pet_type, "quick_chat_enabled": False, "bubble_frequency": 600,
        }),
    )
    assert [read.status_code, update.status_code] == [200, 200]
    async with async_session_maker() as db:
        preferences = (await db.execute(select(UserPreference).where(UserPreference.user_id == user.id))).scalar_one()
        assert (preferences.pet_type, preferences.quick_chat_enabled, preferences.bubble_frequency) == (pet_type, False, 600)


async def test_admin_update_returns_repaired_preferences_in_same_response(preference_client):
    user = await user_without_preferences()
    async with async_session_maker() as db:
        administrator = (await db.execute(select(User).where(User.username == "admin"))).scalar_one()
        token = create_access_token({"sub": str(administrator.id), "username": administrator.username})
    response = await preference_client.put(
        f"/api/v1/admin/users/{user.id}", headers={"Authorization": f"Bearer {token}"},
        json={"username": user.username, "email": user.email, "status": "active", "is_superuser": False},
    )
    assert response.status_code == 200
    assert response.json()["preferences"]["user_id"] == user.id
    assert response.json()["preferences"]["pet_type"] == "pig"


@pytest.mark.parametrize("dialect", [sqlite.dialect(), postgresql.dialect()])
def test_default_insert_uses_supported_dialect_and_specific_conflict_target(dialect):
    compiled = default_preferences_insert(42, dialect.name).compile(dialect=dialect)
    sql = str(compiled)
    assert "ON CONFLICT (user_id) DO NOTHING" in sql
    assert "DO UPDATE" not in sql
    assert compiled.params["user_id"] == 42
    assert compiled.params["pet_type"] == "pig"
    for default_column in ("pet_type", "quick_chat_enabled", "bubble_frequency", "created_at", "updated_at"):
        assert default_column in compiled.params
