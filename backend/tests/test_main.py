from datetime import datetime
from pathlib import Path
import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app  # noqa: E402


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


@pytest.fixture
def successful_chat_model(monkeypatch):
    from app.services.llm.service import llm_service

    async def answer(*_args, **_kwargs):
        yield "A complete test answer."

    monkeypatch.setattr(llm_service, "chat", answer)


def test_api_origins_accepts_json_array_string():
    from app.core.config import Settings  # noqa: E402

    settings = Settings(API_ORIGINS='["http://detachym.top", "http://127.0.0.1"]')
    assert settings.API_ORIGINS == ["http://detachym.top", "http://127.0.0.1"]


def test_api_origins_accepts_comma_separated_string():
    from app.core.config import Settings  # noqa: E402

    settings = Settings(API_ORIGINS="http://detachym.top, http://127.0.0.1, null")
    assert settings.API_ORIGINS == ["http://detachym.top", "http://127.0.0.1", "null"]


async def register_user(client: AsyncClient, *, username: str, email: str, password: str = "Password123!") -> None:
    response = await client.post("/api/v1/auth/send-verification-code", json={"email": email})
    assert response.status_code == 200

    from app.models.database import async_session_maker  # noqa: E402
    from app.models.user import VerificationCode  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async with async_session_maker() as session:
        result = await session.execute(
            select(VerificationCode)
            .where(VerificationCode.email == email, VerificationCode.purpose == "register")
            .order_by(VerificationCode.created_at.desc())
        )
        code = result.scalars().first()
        assert code is not None
        verification_code = code.code

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "email": email,
            "password": password,
            "verification_code": verification_code,
        },
    )
    assert response.status_code == 200


async def login(client: AsyncClient, *, username: str, password: str = "Password123!") -> str:
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


@pytest.mark.asyncio
async def test_root_and_health(client: AsyncClient):
    root_response = await client.get("/")
    assert root_response.status_code == 200
    assert root_response.json()["status"] == "running"

    health_response = await client.get("/health")
    assert health_response.status_code == 200
    assert health_response.json()["status"] == "healthy"

    ready_response = await client.get("/health/ready")
    assert ready_response.status_code == 200
    assert ready_response.json()["status"] == "ready"
    assert ready_response.json()["checks"]["database"] == "ok"


@pytest.mark.asyncio
async def test_readiness_failure_does_not_publish_database_exception_details(client: AsyncClient, monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    @asynccontextmanager
    async def unavailable_database():
        yield SimpleNamespace(execute=AsyncMock(side_effect=RuntimeError("private-database-connection-detail")))

    monkeypatch.setattr("app.main.async_session_maker", unavailable_database)
    response = await client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["detail"]["checks"]["database"] == "error"
    assert "private-database-connection-detail" not in response.text


@pytest.mark.asyncio
async def test_auth_preferences_and_password_reset(client: AsyncClient):
    await register_user(client, username="alice", email="alice@example.com")

    token = await login(client, username="alice")
    headers = {"Authorization": f"Bearer {token}"}

    me_response = await client.get("/api/v1/auth/me", headers=headers)
    assert me_response.status_code == 200
    assert me_response.json()["preferences"]["pet_type"] == "pig"

    pref_response = await client.put(
        "/api/v1/users/me/preferences",
        headers=headers,
        json={
            "pet_type": "dog",
            "quick_chat_enabled": True,
            "bubble_frequency": 180,
        },
    )
    assert pref_response.status_code == 200
    assert pref_response.json()["pet_type"] == "dog"

    change_password_response = await client.post(
        "/api/v1/auth/change-password",
        headers=headers,
        json={"current_password": "Password123!", "new_password": "NewPassword123!"},
    )
    assert change_password_response.status_code == 200

    forgot_response = await client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "alice@example.com"},
    )
    assert forgot_response.status_code == 200

    from app.models.database import async_session_maker  # noqa: E402
    from app.models.user import VerificationCode  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async with async_session_maker() as session:
        result = await session.execute(
            select(VerificationCode)
            .where(VerificationCode.email == "alice@example.com", VerificationCode.purpose == "reset_password")
            .order_by(VerificationCode.created_at.desc())
        )
        code = result.scalars().first()
        assert code is not None
        reset_code = code.code

    reset_response = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "email": "alice@example.com",
            "verification_code": reset_code,
            "new_password": "ResetPassword123!",
        },
    )
    assert reset_response.status_code == 200

    reset_login = await client.post(
        "/api/v1/auth/login",
        data={"username": "alice", "password": "ResetPassword123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert reset_login.status_code == 200

    email_login = await client.post(
        "/api/v1/auth/login",
        data={"username": "alice@example.com", "password": "ResetPassword123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert email_login.status_code == 200


@pytest.mark.asyncio
async def test_register_rejects_existing_email_and_chat_accepts_pet_type(client: AsyncClient, successful_chat_model):
    await register_user(client, username="petuser", email="petuser@example.com")

    duplicate_code_response = await client.post(
        "/api/v1/auth/send-verification-code",
        json={"email": "petuser@example.com"},
    )
    assert duplicate_code_response.status_code == 400
    assert duplicate_code_response.json()["detail"] == "Email already registered"

    token = await login(client, username="petuser")
    headers = {"Authorization": f"Bearer {token}"}

    chat_response = await client.post(
        "/api/v1/chat/message",
        headers=headers,
        json={
            "message": "Hello desktop pet",
            "use_rag": False,
            "pet_type": "dog",
        },
    )
    assert chat_response.status_code == 200
    assert chat_response.json()["session_id"] > 0
    assert chat_response.json()["knowledge_used"] is False
    assert chat_response.json()["sources"] == []

    daily_summary = await client.get("/api/v1/pets/dog/daily-summary", headers=headers)
    assert daily_summary.status_code == 200
    assert daily_summary.json()["interaction_count"] == 1
    assert daily_summary.json()["meaningful_chat_count"] == 1
    assert daily_summary.json()["xp_gained"] == 2


@pytest.mark.asyncio
async def test_public_release_endpoint_reflects_download_file(client: AsyncClient):
    from app.core.config import settings  # noqa: E402

    release_response = await client.get("/api/v1/public/version/win-x64")
    assert release_response.status_code == 200
    assert release_response.json()["available"] is False

    release_file = Path(settings.DOWNLOAD_DIR) / settings.DESKTOP_RELEASE_FILE
    release_file.parent.mkdir(parents=True, exist_ok=True)
    release_file.write_bytes(b"binary")

    refreshed_response = await client.get("/api/v1/public/version/win-x64")
    assert refreshed_response.status_code == 200
    assert refreshed_response.json()["available"] is True
    assert refreshed_response.json()["filename"] == settings.DESKTOP_RELEASE_FILE
    published_at = datetime.fromisoformat(refreshed_response.json()["published_at"])
    assert published_at.utcoffset().total_seconds() == 0
    assert abs(published_at.timestamp() - release_file.stat().st_mtime) < 0.001


@pytest.mark.asyncio
async def test_public_release_does_not_advertise_directory_as_installer(client: AsyncClient, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "DESKTOP_RELEASE_FILE", "directory-is-not-an-installer.exe")
    release_directory = Path(settings.DOWNLOAD_DIR) / settings.DESKTOP_RELEASE_FILE
    release_directory.mkdir()
    response = await client.get("/api/v1/public/version/win-x64")
    assert response.status_code == 200
    assert response.json()["available"] is False
    assert response.json()["published_at"] is None


@pytest.mark.asyncio
async def test_chat_stream_preserves_compact_prompt_and_rag_sources(client: AsyncClient, monkeypatch):
    await register_user(client, username="streamuser", email="streamuser@example.com")
    token = await login(client, username="streamuser")
    headers = {"Authorization": f"Bearer {token}"}

    upload_response = await client.post(
        "/api/v1/rag/upload",
        headers=headers,
        files={"file": ("guide.md", b"stream compact knowledge about gamma", "text/markdown")},
    )
    assert upload_response.status_code == 200

    captured_messages = []

    async def fake_chat(messages, stream=True, temperature=0.7, max_tokens=None):
        captured_messages[:] = messages
        if stream:
            yield "chunk-1"
            yield "chunk-2"
            return
        yield "complete-response"

    from app.services.chat import service as chat_service_module  # noqa: E402

    monkeypatch.setattr(chat_service_module.llm_service, "chat", fake_chat)

    async with client.stream(
        "POST",
        "/api/v1/chat/stream",
        headers=headers,
        json={
            "message": "Tell me about gamma",
            "use_rag": True,
            "pet_type": "cat",
            "compact_response": True,
        },
    ) as response:
        assert response.status_code == 200
        payloads = []
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                payloads.append(json.loads(line[6:]))

    assert len(payloads) >= 4
    assert payloads[0]["session_id"] > 0
    assert payloads[0]["knowledge_used"] is True
    assert payloads[0]["sources"][0]["filename"] == "guide.md"
    assert payloads[-1]["done"] is True
    assert payloads[-1]["knowledge_used"] is True

    system_prompts = [item.content for item in captured_messages if item.role == "system"]
    assert any("desktop cat companion" in prompt for prompt in system_prompts)
    assert any("small desktop pet bubble" in prompt for prompt in system_prompts)
    assert any("knowledge base context" in prompt for prompt in system_prompts)


@pytest.mark.asyncio
@pytest.mark.parametrize("stream_end", ["complete", "close", "disconnect"])
async def test_chat_stream_owns_and_releases_its_database_session(
    client: AsyncClient, monkeypatch, stream_end: str,
):
    import asyncio
    from sqlalchemy import event, select
    from app.api.v1.chat import chat_stream
    from app.models.database import User, async_session_maker, engine
    from app.schemas.chat import ChatRequest
    from app.services.chat import service as chat_service_module

    username = f"stream-lifecycle-{stream_end}"
    await register_user(client, username=username, email=f"{username}@example.com")

    async def fake_chat(*_args, **_kwargs):
        yield "a partial response"
        yield " and its conclusion"

    monkeypatch.setattr(chat_service_module.llm_service, "chat", fake_chat)
    async with async_session_maker() as request_db:
        user = (await request_db.execute(select(User).where(User.username == username))).scalar_one()
        response = await chat_stream(
            request=ChatRequest(message="Keep me company", pet_type="pig"),
            current_user=user,
        )
    # FastAPI 0.115 closes request dependencies before StreamingResponse starts.
    checked_out = set()

    def on_checkout(_connection, record, _proxy):
        checked_out.add(id(record))

    def on_checkin(_connection, record):
        checked_out.discard(id(record))

    event.listen(engine.sync_engine, "checkout", on_checkout)
    event.listen(engine.sync_engine, "checkin", on_checkin)
    try:
        body = response.body_iterator
        if stream_end == "disconnect":
            body_started = asyncio.Event()

            async def receive():
                await body_started.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.body":
                    body_started.set()
                    await asyncio.Event().wait()

            await asyncio.wait_for(response({"type": "http"}, receive, send), timeout=5)
        else:
            await anext(body)  # Session metadata.
            await anext(body)  # First provider chunk.
            if stream_end == "complete":
                async for _ in body:
                    pass
            else:
                await body.aclose()
        assert checked_out == set(), "The stream left a database connection checked out"
    finally:
        await response.body_iterator.aclose()
        event.remove(engine.sync_engine, "checkout", on_checkout)
        event.remove(engine.sync_engine, "checkin", on_checkin)


@pytest.mark.asyncio
async def test_internal_chat_tool_requires_key_and_uses_llm(client: AsyncClient, monkeypatch):
    from app.core import security as security_module  # noqa: E402
    from app.api.v1 import tools as tools_module  # noqa: E402

    monkeypatch.setattr(security_module.settings, "BACKEND_INTERNAL_API_KEY", "internal-test-key")
    captured_messages = []

    async def fake_chat(messages, stream=True, temperature=0.7, max_tokens=None):
        captured_messages[:] = messages
        yield "内部通用回答"

    monkeypatch.setattr(tools_module.llm_service, "chat", fake_chat)

    unauthorized = await client.post(
        "/api/v1/tools/internal/chat",
        json={"messages": [{"role": "user", "content": "讲一个使用建议"}]},
    )
    assert unauthorized.status_code == 401

    response = await client.post(
        "/api/v1/tools/internal/chat",
        headers={"X-Internal-Api-Key": "internal-test-key"},
        json={"messages": [{"role": "user", "content": "讲一个使用建议"}], "pet_type": "dog"},
    )
    assert response.status_code == 200
    assert response.json()["content"] == "内部通用回答"
    assert captured_messages[-1].role == "user"
    assert captured_messages[-1].content == "讲一个使用建议"
    assert any(item.role == "system" and "desktop dog companion" in item.content for item in captured_messages)


@pytest.mark.asyncio
async def test_legacy_short_username_can_still_login_and_fetch_profile(client: AsyncClient):
    from app.core.security import get_password_hash  # noqa: E402
    from app.models.database import User, UserPreference, async_session_maker  # noqa: E402

    async with async_session_maker() as session:
        legacy_user = User(
            username="11",
            email="legacy@example.com",
            hashed_password=get_password_hash("LegacyPass123!"),
            status="active",
            is_active=True,
        )
        session.add(legacy_user)
        await session.flush()
        session.add(UserPreference(user_id=legacy_user.id))
        await session.commit()

    login_response = await client.post(
        "/api/v1/auth/login",
        data={"username": "legacy@example.com", "password": "LegacyPass123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert login_response.status_code == 200
    token = login_response.json()["access_token"]

    me_response = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_response.status_code == 200
    assert me_response.json()["username"] == "11"


@pytest.mark.asyncio
async def test_admin_disable_user_and_rag_isolation(client: AsyncClient, successful_chat_model):
    await register_user(client, username="bob", email="bob@example.com")
    await register_user(client, username="carol", email="carol@example.com")

    bob_token = await login(client, username="bob")
    carol_token = await login(client, username="carol")
    admin_token = await login(client, username="admin", password="ChangeThisPassword123!")

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    bob_headers = {"Authorization": f"Bearer {bob_token}"}
    carol_headers = {"Authorization": f"Bearer {carol_token}"}

    overview_response = await client.get("/api/v1/admin/overview", headers=admin_headers)
    assert overview_response.status_code == 200
    assert overview_response.json()["total_users"] >= 3

    bob_upload = await client.post(
        "/api/v1/rag/upload",
        headers=bob_headers,
        files={"file": ("bob.md", b"bob private note about alpha", "text/markdown")},
    )
    assert bob_upload.status_code == 200

    carol_upload = await client.post(
        "/api/v1/rag/upload",
        headers=carol_headers,
        files={"file": ("carol.md", b"carol private note about beta", "text/markdown")},
    )
    assert carol_upload.status_code == 200

    users_response = await client.get("/api/v1/admin/users?search=bob", headers=admin_headers)
    assert users_response.status_code == 200
    bob_user = users_response.json()["items"][0]

    disable_response = await client.patch(
        f"/api/v1/admin/users/{bob_user['id']}/status",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disable_response.status_code == 200
    assert disable_response.json()["status"] == "disabled"

    disabled_login = await client.post(
        "/api/v1/auth/login",
        data={"username": "bob", "password": "Password123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert disabled_login.status_code == 403

    carol_query = await client.post(
        "/api/v1/rag/query",
        headers=carol_headers,
        json={"question": "What is beta?", "top_k": 4},
    )
    assert carol_query.status_code == 200
    sources = carol_query.json()["sources"]
    assert len(sources) == 1
    assert sources[0]["filename"] == "carol.md"

    carol_chat = await client.post(
        "/api/v1/chat/message",
        headers=carol_headers,
        json={
            "message": "What does my knowledge base say about beta?",
            "use_rag": True,
            "pet_type": "pig",
        },
    )
    assert carol_chat.status_code == 200
    assert carol_chat.json()["knowledge_used"] is True
    assert carol_chat.json()["sources"][0]["filename"] == "carol.md"


@pytest.mark.asyncio
async def test_admin_user_crud_and_self_protection(client: AsyncClient):
    admin_token = await login(client, username="admin", password="ChangeThisPassword123!")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    create_response = await client.post(
        "/api/v1/admin/users",
        headers=admin_headers,
        json={
            "username": "manageduser",
            "email": "managed@example.com",
            "password": "ManagedPass123!",
            "status": "active",
            "is_superuser": False,
        },
    )
    assert create_response.status_code == 201
    created_user = create_response.json()
    assert created_user["username"] == "manageduser"
    assert created_user["is_superuser"] is False

    update_response = await client.put(
        f"/api/v1/admin/users/{created_user['id']}",
        headers=admin_headers,
        json={
            "username": "manageduser2",
            "email": "managed2@example.com",
            "password": "ManagedPass456!",
            "status": "active",
            "is_superuser": True,
        },
    )
    assert update_response.status_code == 200
    updated_user = update_response.json()
    assert updated_user["username"] == "manageduser2"
    assert updated_user["email"] == "managed2@example.com"
    assert updated_user["is_superuser"] is True

    updated_login = await client.post(
        "/api/v1/auth/login",
        data={"username": "managed2@example.com", "password": "ManagedPass456!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert updated_login.status_code == 200

    admin_me = await client.get("/api/v1/auth/me", headers=admin_headers)
    assert admin_me.status_code == 200
    admin_id = admin_me.json()["id"]

    self_disable_response = await client.patch(
        f"/api/v1/admin/users/{admin_id}/status",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert self_disable_response.status_code == 400

    self_demotion_response = await client.put(
        f"/api/v1/admin/users/{admin_id}",
        headers=admin_headers,
        json={
            "username": "admin",
            "email": "admin@example.com",
            "password": "ChangeThisPassword123!",
            "status": "active",
            "is_superuser": False,
        },
    )
    assert self_demotion_response.status_code == 400

    self_delete_response = await client.delete(f"/api/v1/admin/users/{admin_id}", headers=admin_headers)
    assert self_delete_response.status_code == 400

    delete_response = await client.delete(
        f"/api/v1/admin/users/{created_user['id']}",
        headers=admin_headers,
    )
    assert delete_response.status_code == 200

    deleted_login = await client.post(
        "/api/v1/auth/login",
        data={"username": "managed2@example.com", "password": "ManagedPass456!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert deleted_login.status_code == 401


@pytest.mark.asyncio
async def test_admin_weekly_review_funnel_is_aggregated_and_private(
    client: AsyncClient,
):
    for username in ("funnel-a", "funnel-b", "funnel-c"):
        await register_user(
            client,
            username=username,
            email=f"{username}@example.com",
        )

    admin_token = await login(
        client,
        username="admin",
        password="ChangeThisPassword123!",
    )
    user_token = await login(client, username="funnel-a")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    user_headers = {"Authorization": f"Bearer {user_token}"}

    from sqlalchemy import select  # noqa: E402
    from app.models.database import (  # noqa: E402
        PetRetentionEvent,
        User,
        async_session_maker,
    )

    async with async_session_maker() as session:
        users = (
            (
                await session.execute(
                    select(User).where(
                        User.username.in_(("funnel-a", "funnel-b", "funnel-c"))
                    )
                )
            )
            .scalars()
            .all()
        )
        user_ids = {user.username: user.id for user in users}

        older_review = "2026-07-27_2026-08-02"
        newer_review = "2026-08-03_2026-08-09"
        rows = [
            ("funnel-a", "pig", "weekly_review_generated", older_review),
            ("funnel-b", "pig", "weekly_review_generated", older_review),
            ("funnel-b", "pig", "weekly_review_shown", older_review),
            ("funnel-b", "pig", "weekly_review_seen", older_review),
            ("funnel-b", "pig", "weekly_review_follow_up_care", older_review),
            ("funnel-b", "pig", "weekly_review_follow_up_chat", older_review),
            ("funnel-c", "pig", "weekly_review_generated", older_review),
            ("funnel-c", "pig", "weekly_review_shown", older_review),
            ("funnel-c", "pig", "weekly_review_seen", older_review),
            ("funnel-c", "pig", "weekly_review_follow_up_reminder", older_review),
            ("funnel-a", "pig", "weekly_review_generated", newer_review),
            ("funnel-a", "pig", "weekly_review_shown", newer_review),
            ("funnel-b", "pig", "weekly_review_seen", newer_review),
            ("funnel-c", "pig", "weekly_review_follow_up_reminder", newer_review),
            ("funnel-c", "cat", "weekly_review_generated", newer_review),
        ]
        session.add_all(
            [
                PetRetentionEvent(
                    user_id=user_ids[username],
                    pet_type=pet_type,
                    event_type=event_type,
                    review_key=review_key,
                    occurred_at=datetime(2026, 8, 11, 3, 0, 0),
                )
                for username, pet_type, event_type, review_key in rows
            ]
        )
        await session.commit()

    unauthorized = await client.get("/api/v1/admin/retention/weekly-reviews")
    assert unauthorized.status_code == 401
    forbidden = await client.get(
        "/api/v1/admin/retention/weekly-reviews",
        headers=user_headers,
    )
    assert forbidden.status_code == 403

    response = await client.get(
        "/api/v1/admin/retention/weekly-reviews?pet_type=pig",
        headers=admin_headers,
    )
    assert response.status_code == 200
    assert response.json() == {
        "pet_type": "pig",
        "items": [
            {
                "review_key": newer_review,
                "generated_users": 3,
                "shown_users": 3,
                "seen_users": 2,
                "follow_up_users": 1,
                "follow_up_care_users": 0,
                "follow_up_chat_users": 0,
                "follow_up_reminder_users": 1,
                "shown_from_generated_rate": 1.0,
                "seen_from_shown_rate": 0.6667,
                "follow_up_from_seen_rate": 0.5,
            },
            {
                "review_key": older_review,
                "generated_users": 3,
                "shown_users": 2,
                "seen_users": 2,
                "follow_up_users": 2,
                "follow_up_care_users": 1,
                "follow_up_chat_users": 1,
                "follow_up_reminder_users": 1,
                "shown_from_generated_rate": 0.6667,
                "seen_from_shown_rate": 1.0,
                "follow_up_from_seen_rate": 1.0,
            },
        ],
    }
    assert "user_id" not in response.text
    assert "funnel-a" not in response.text

    limited = await client.get(
        "/api/v1/admin/retention/weekly-reviews?pet_type=pig&limit=1",
        headers=admin_headers,
    )
    assert limited.status_code == 200
    assert [item["review_key"] for item in limited.json()["items"]] == [newer_review]

    empty = await client.get(
        "/api/v1/admin/retention/weekly-reviews?pet_type=dog",
        headers=admin_headers,
    )
    assert empty.status_code == 200
    assert empty.json() == {"pet_type": "dog", "items": []}

    invalid_pet = await client.get(
        "/api/v1/admin/retention/weekly-reviews?pet_type=horse",
        headers=admin_headers,
    )
    assert invalid_pet.status_code == 422
    invalid_limit = await client.get(
        "/api/v1/admin/retention/weekly-reviews?limit=53",
        headers=admin_headers,
    )
    assert invalid_limit.status_code == 422


@pytest.mark.asyncio
async def test_admin_delete_user_cleans_documents_and_files(client: AsyncClient):
    await register_user(client, username="cleanupuser", email="cleanup@example.com")

    admin_token = await login(client, username="admin", password="ChangeThisPassword123!")
    cleanup_token = await login(client, username="cleanupuser")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    cleanup_headers = {"Authorization": f"Bearer {cleanup_token}"}

    upload_response = await client.post(
        "/api/v1/rag/upload",
        headers=cleanup_headers,
        files={"file": ("cleanup.md", b"cleanup content for deletion", "text/markdown")},
    )
    assert upload_response.status_code == 200

    from app.models.database import async_session_maker  # noqa: E402
    from app.models.document import Document  # noqa: E402
    from app.models.user import User  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async with async_session_maker() as session:
        user_result = await session.execute(select(User).where(User.username == "cleanupuser"))
        cleanup_user = user_result.scalar_one()
        document_result = await session.execute(select(Document).where(Document.user_id == cleanup_user.id))
        document = document_result.scalar_one()
        file_path = Path(document.file_path)
        assert file_path.exists()
        cleanup_user_id = cleanup_user.id

    delete_response = await client.delete(f"/api/v1/admin/users/{cleanup_user_id}", headers=admin_headers)
    assert delete_response.status_code == 200

    assert not file_path.exists()

    async with async_session_maker() as session:
        user_result = await session.execute(select(User).where(User.id == cleanup_user_id))
        document_result = await session.execute(select(Document).where(Document.user_id == cleanup_user_id))
        assert user_result.scalar_one_or_none() is None
        assert document_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_document_indexing_keeps_health_requests_responsive(client: AsyncClient, monkeypatch):
    import asyncio
    from threading import Event

    from app.services.rag import rag_service

    await register_user(client, username="slowindex", email="slowindex@example.com")
    token = await login(client, username="slowindex")
    started = Event()
    release = Event()

    def blocking_index(**kwargs):
        started.set()
        if not release.wait(timeout=4):
            raise RuntimeError("index did not run concurrently with health request")
        return 2

    monkeypatch.setattr(rag_service, "index_document", blocking_index)
    upload = asyncio.create_task(client.post(
        "/api/v1/rag/upload",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("slow.md", b"slow knowledge", "text/markdown")},
    ))

    async def wait_for_index():
        while not started.is_set():
            await asyncio.sleep(0.01)

    try:
        await asyncio.wait_for(wait_for_index(), timeout=2)
        assert not upload.done()
        response = await asyncio.wait_for(client.get("/health"), timeout=1)
        assert response.status_code == 200
        assert not upload.done()
    finally:
        release.set()
        upload_response = await asyncio.wait_for(upload, timeout=3)

    assert upload_response.status_code == 200
    assert upload_response.json()["chunk_count"] == 2


@pytest.mark.asyncio
async def test_failed_document_upload_remains_visible_and_owner_can_delete(client: AsyncClient, monkeypatch):
    from sqlalchemy import select

    from app.models.database import async_session_maker
    from app.models.document import Document
    from app.services.rag import rag_service

    await register_user(client, username="badindex", email="badindex@example.com")
    await register_user(client, username="otherindex", email="otherindex@example.com")
    token = await login(client, username="badindex")
    other_token = await login(client, username="otherindex")
    headers = {"Authorization": f"Bearer {token}"}

    def failed_index(**kwargs):
        raise ValueError("Document has no readable content")

    monkeypatch.setattr(rag_service, "index_document", failed_index)
    response = await client.post(
        "/api/v1/rag/upload",
        headers=headers,
        files={"file": ("empty.pdf", b"unreadable pdf", "application/pdf")},
    )
    assert response.status_code == 400
    documents = (await client.get("/api/v1/rag/documents", headers=headers)).json()
    assert len(documents) == 1
    assert documents[0]["status"] == "failed"
    assert documents[0]["chunk_count"] == 0
    document_id = documents[0]["id"]

    async with async_session_maker() as session:
        document = (await session.execute(select(Document).where(Document.id == document_id))).scalar_one()
        file_path = Path(document.file_path)
    assert file_path.exists()

    denied = await client.delete(
        f"/api/v1/rag/documents/{document_id}", headers={"Authorization": f"Bearer {other_token}"},
    )
    assert denied.status_code == 404
    assert file_path.exists()
    deleted = await client.delete(f"/api/v1/rag/documents/{document_id}", headers=headers)
    assert deleted.status_code == 200
    assert not file_path.exists()
    assert (await client.get("/api/v1/rag/documents", headers=headers)).json() == []


@pytest.mark.asyncio
async def test_rag_retrieval_and_deletion_run_outside_request_thread(client: AsyncClient, monkeypatch, successful_chat_model):
    from threading import get_ident

    from app.services.rag import RAGContext, rag_service

    await register_user(client, username="ragthreads", email="ragthreads@example.com")
    token = await login(client, username="ragthreads")
    headers = {"Authorization": f"Bearer {token}"}
    uploaded = await client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("threads.md", b"threaded knowledge", "text/markdown")},
    )
    assert uploaded.status_code == 200
    request_thread = get_ident()
    worker_calls = []
    original_delete = rag_service.delete_document

    def build_context(**kwargs):
        worker_calls.append(("query", get_ident()))
        return RAGContext(context="", sources=[])

    def delete_document(document_id):
        worker_calls.append(("delete", get_ident()))
        original_delete(document_id)

    monkeypatch.setattr(rag_service, "build_context", build_context)
    monkeypatch.setattr(rag_service, "delete_document", delete_document)
    assert (await client.post("/api/v1/rag/query", headers=headers, json={"question": "notes?"})).status_code == 200
    assert (await client.post(
        "/api/v1/chat/message", headers=headers, json={"message": "notes?", "use_rag": True},
    )).status_code == 200
    assert (await client.delete(f"/api/v1/rag/documents/{uploaded.json()['id']}", headers=headers)).status_code == 200

    assert [name for name, _ in worker_calls] == ["query", "query", "delete"]
    assert all(thread_id != request_thread for _, thread_id in worker_calls)


@pytest.mark.asyncio
async def test_document_upload_size_limit_accepts_boundary_and_rejects_extra_byte(client: AsyncClient, monkeypatch):
    from app.core.config import settings

    await register_user(client, username="uploadlimit", email="uploadlimit@example.com")
    token = await login(client, username="uploadlimit")
    headers = {"Authorization": f"Bearer {token}"}
    monkeypatch.setattr(settings, "MAX_UPLOAD_SIZE", 5)
    accepted = await client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("small.txt", b"12345", "text/plain")},
    )
    rejected = await client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("large.txt", b"123456", "text/plain")},
    )
    assert accepted.status_code == 200
    assert rejected.status_code == 400
    documents = (await client.get("/api/v1/rag/documents", headers=headers)).json()
    assert len(documents) == 1
    assert documents[0]["filename"] == "small.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize("delete_owner", [False, True])
async def test_document_upload_and_deletion_cannot_leave_orphan_index(client: AsyncClient, monkeypatch, delete_owner):
    import asyncio
    from threading import Event

    from app.models.database import async_session_maker
    from app.models.document import Document
    from app.models.user import User
    from app.services.rag import rag_service
    from sqlalchemy import select

    username = "raceowner" if delete_owner else "racedocument"
    await register_user(client, username=username, email=f"{username}@example.com")
    token = await login(client, username=username)
    admin_token = await login(client, username="admin", password="ChangeThisPassword123!")
    headers = {"Authorization": f"Bearer {token}"}
    user_id = (await client.get("/api/v1/auth/me", headers=headers)).json()["id"]
    started = Event()
    release = Event()
    original_index = rag_service.index_document

    def blocked_index(**kwargs):
        started.set()
        assert release.wait(timeout=5)
        return original_index(**kwargs)

    monkeypatch.setattr(rag_service, "index_document", blocked_index)
    upload = asyncio.create_task(client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("race.md", b"concurrent document deletion", "text/markdown")},
    ))

    async def wait_for(predicate):
        while not predicate():
            await asyncio.sleep(0.01)

    deletion = None
    try:
        await asyncio.wait_for(wait_for(started.is_set), timeout=2)
        documents = (await client.get("/api/v1/rag/documents", headers=headers)).json()
        assert len(documents) == 1
        assert documents[0]["status"] == "uploaded"
        document_id = documents[0]["id"]
        async with async_session_maker() as session:
            document = (await session.execute(select(Document).where(Document.id == document_id))).scalar_one()
            file_path = Path(document.file_path)

        delete_path = f"/api/v1/admin/users/{user_id}" if delete_owner else f"/api/v1/rag/documents/{document_id}"
        delete_headers = {"Authorization": f"Bearer {admin_token}"} if delete_owner else headers
        deletion = asyncio.create_task(client.delete(delete_path, headers=delete_headers))
        await asyncio.wait_for(wait_for(lambda: rag_service._user_operations[user_id][1] == 2), timeout=2)
        assert not deletion.done()
        assert (await asyncio.wait_for(client.get("/health"), timeout=1)).status_code == 200
    finally:
        release.set()
        uploaded = await asyncio.wait_for(upload, timeout=3)
        if deletion is not None:
            deleted = await asyncio.wait_for(deletion, timeout=3)

    assert uploaded.status_code == 200
    assert deleted.status_code == 200
    assert not file_path.exists()
    async with async_session_maker() as session:
        assert await session.scalar(select(Document.id).where(Document.id == document_id)) is None
        if delete_owner:
            assert await session.scalar(select(User.id).where(User.id == user_id)) is None
    assert rag_service._get_collection().get(where={"document_id": str(document_id)})["ids"] == []
    assert user_id not in rag_service._user_operations


@pytest.mark.asyncio
async def test_document_upload_waiting_on_owner_deletion_rechecks_owner(client: AsyncClient, monkeypatch):
    import asyncio
    from threading import Event

    from sqlalchemy import select

    from app.models.database import async_session_maker
    from app.models.document import Document
    from app.services.rag import rag_service

    await register_user(client, username="queuedowner", email="queuedowner@example.com")
    token = await login(client, username="queuedowner")
    admin_token = await login(client, username="admin", password="ChangeThisPassword123!")
    headers = {"Authorization": f"Bearer {token}"}
    user_id = (await client.get("/api/v1/auth/me", headers=headers)).json()["id"]
    first_upload = await client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("original.md", b"original note", "text/markdown")},
    )
    assert first_upload.status_code == 200
    started = Event()
    release = Event()
    original_delete = rag_service.delete_document

    def blocked_delete(document_id):
        started.set()
        assert release.wait(timeout=5)
        original_delete(document_id)

    monkeypatch.setattr(rag_service, "delete_document", blocked_delete)
    deletion = asyncio.create_task(client.delete(
        f"/api/v1/admin/users/{user_id}", headers={"Authorization": f"Bearer {admin_token}"},
    ))

    async def wait_for(predicate):
        while not predicate():
            await asyncio.sleep(0.01)

    upload = None
    try:
        await asyncio.wait_for(wait_for(started.is_set), timeout=2)
        upload = asyncio.create_task(client.post(
            "/api/v1/rag/upload", headers=headers,
            files={"file": ("too-late.md", b"must not survive owner", "text/markdown")},
        ))
        await asyncio.wait_for(wait_for(lambda: rag_service._user_operations[user_id][1] == 2), timeout=2)
        assert not upload.done()
    finally:
        release.set()
        deleted = await asyncio.wait_for(deletion, timeout=3)
        if upload is not None:
            uploaded = await asyncio.wait_for(upload, timeout=3)

    assert deleted.status_code == 200
    assert uploaded.status_code == 401
    async with async_session_maker() as session:
        assert await session.scalar(select(Document.id).where(Document.user_id == user_id)) is None
    assert rag_service._get_collection().get(where={"user_id": str(user_id)})["ids"] == []
    assert user_id not in rag_service._user_operations


@pytest.mark.asyncio
async def test_cancelled_document_upload_waits_for_index_and_removes_late_vectors(client: AsyncClient, monkeypatch):
    import asyncio
    from threading import Event

    from app.services.rag import rag_service

    await register_user(client, username="cancelindex", email="cancelindex@example.com")
    token = await login(client, username="cancelindex")
    headers = {"Authorization": f"Bearer {token}"}
    user_id = (await client.get("/api/v1/auth/me", headers=headers)).json()["id"]
    started = Event()
    release = Event()
    original_index = rag_service.index_document

    def blocked_index(**kwargs):
        started.set()
        assert release.wait(timeout=4)
        return original_index(**kwargs)

    monkeypatch.setattr(rag_service, "index_document", blocked_index)
    upload = asyncio.create_task(client.post(
        "/api/v1/rag/upload", headers=headers,
        files={"file": ("cancelled.md", b"must not survive cancelled request", "text/markdown")},
    ))

    async def wait_for_index():
        while not started.is_set():
            await asyncio.sleep(0.01)

    try:
        await asyncio.wait_for(wait_for_index(), timeout=2)
        upload.cancel()
        await asyncio.sleep(0.01)
        assert user_id in rag_service._user_operations
        assert not upload.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(upload, timeout=3)

    documents = (await client.get("/api/v1/rag/documents", headers=headers)).json()
    assert len(documents) == 1
    assert documents[0]["status"] == "failed"
    assert documents[0]["chunk_count"] == 0
    assert rag_service._get_collection().get(where={"user_id": str(user_id)})["ids"] == []
    assert user_id not in rag_service._user_operations
    assert (await client.delete(f"/api/v1/rag/documents/{documents[0]['id']}", headers=headers)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["message", "stream"])
@pytest.mark.parametrize("failure", ["unconfigured", "before_content", "partial", "empty"])
async def test_failed_chat_has_no_assistant_history_or_relationship_reward(
    client: AsyncClient, monkeypatch, endpoint: str, failure: str,
):
    from app.services.llm.service import llm_service

    username = f"failure-{endpoint}-{failure}"
    await register_user(client, username=username, email=f"{username}@example.com")
    token = await login(client, username=username)
    headers = {"Authorization": f"Bearer {token}"}
    monkeypatch.setattr(llm_service, "_providers", {})

    async def broken_provider(*_args, **_kwargs):
        if failure == "partial":
            yield "incomplete provider answer"
        if failure == "empty":
            yield "   "
            return
        raise RuntimeError("private provider failure details")

    if failure != "unconfigured":
        monkeypatch.setattr(llm_service, "chat", broken_provider)

    response = await client.post(
        f"/api/v1/chat/{endpoint}", headers=headers,
        json={"message": "Please help me plan my day", "pet_type": "pig"},
    )
    if endpoint == "message":
        assert response.status_code == 503
        assert response.json()["detail"] == "暂时无法生成回答，请稍后重试。"
    else:
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["done"] is True
        assert events[-1]["error"] == "provider_unavailable"
        assert events[-1]["message"] == "暂时无法生成回答，请稍后重试。"
        assert len([event for event in events if event.get("done")]) == 1
    assert "private provider failure" not in response.text

    sessions = (await client.get("/api/v1/chat/sessions", headers=headers)).json()
    assert len(sessions) == 1
    assert [message["role"] for message in sessions[0]["messages"]] == ["user"]
    summary = (await client.get("/api/v1/pets/pig/daily-summary", headers=headers)).json()
    assert summary["meaningful_chat_count"] == 0
    assert summary["xp_gained"] == 0

    async def recovered_provider(*_args, **_kwargs):
        yield "A useful complete answer."

    monkeypatch.setattr(llm_service, "chat", recovered_provider)
    recovered = await client.post(
        "/api/v1/chat/message", headers=headers,
        json={"message": "Try again", "session_id": sessions[0]["id"], "pet_type": "pig"},
    )
    assert recovered.status_code == 200
    assert recovered.json()["session_id"] == sessions[0]["id"]
    messages = (await client.get(f"/api/v1/chat/sessions/{sessions[0]['id']}", headers=headers)).json()["messages"]
    assert [message["content"] for message in messages if message["role"] == "assistant"] == ["A useful complete answer."]
    summary = (await client.get("/api/v1/pets/pig/daily-summary", headers=headers)).json()
    assert summary["meaningful_chat_count"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["message", "stream"])
async def test_explicit_missing_or_foreign_chat_session_does_not_create_replacement(
    client: AsyncClient, monkeypatch, endpoint: str,
):
    from app.models.database import ChatSession, User, async_session_maker
    from app.services.llm.service import llm_service
    from sqlalchemy import select

    username = f"session-owner-{endpoint}"
    await register_user(client, username=username, email=f"{username}@example.com")
    token = await login(client, username=username)
    headers = {"Authorization": f"Bearer {token}"}
    async with async_session_maker() as db:
        owner = (await db.execute(select(User).where(User.username == username))).scalar_one()
        admin = (await db.execute(select(User).where(User.username == "admin"))).scalar_one()
        foreign = ChatSession(user_id=admin.id, title="Private conversation")
        removed = ChatSession(user_id=owner.id, title="Deleted conversation")
        db.add_all([foreign, removed])
        await db.commit()
        foreign_id, removed_id = foreign.id, removed.id

    assert (await client.delete(f"/api/v1/chat/sessions/{removed_id}", headers=headers)).status_code == 200

    async def must_not_generate(*_args, **_kwargs):
        pytest.fail("An invalid conversation must be rejected before calling the model")
        yield "unreachable"

    monkeypatch.setattr(llm_service, "chat", must_not_generate)
    for session_id in [foreign_id, removed_id, 0, 999999]:
        response = await client.post(
            f"/api/v1/chat/{endpoint}", headers=headers,
            json={"message": "Do not silently replace this conversation", "session_id": session_id},
        )
        assert response.status_code == 404
        assert response.json()["detail"] == "这段对话已不可用，请打开其他对话或开始新对话。"
    assert (await client.get("/api/v1/chat/sessions", headers=headers)).json() == []


@pytest.mark.asyncio
async def test_internal_chat_without_provider_reports_service_unavailable(client: AsyncClient, monkeypatch):
    from app.core import security as security_module
    from app.services.llm.service import llm_service

    monkeypatch.setattr(security_module.settings, "BACKEND_INTERNAL_API_KEY", "local-test-key")
    monkeypatch.setattr(llm_service, "_providers", {})
    response = await client.post(
        "/api/v1/tools/internal/chat", headers={"X-Internal-Api-Key": "local-test-key"},
        json={"messages": [{"role": "user", "content": "Help me plan"}]},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "暂时无法生成回答，请稍后重试。"


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", " \n\t"])
async def test_internal_chat_empty_provider_output_reports_service_unavailable(client: AsyncClient, monkeypatch, content):
    from app.core import security as security_module
    from app.services.llm.service import llm_service

    async def empty_answer(*_args, **_kwargs):
        yield content

    monkeypatch.setattr(security_module.settings, "BACKEND_INTERNAL_API_KEY", "local-test-key")
    monkeypatch.setattr(llm_service, "chat", empty_answer)
    response = await client.post(
        "/api/v1/tools/internal/chat", headers={"X-Internal-Api-Key": "local-test-key"},
        json={"messages": [{"role": "user", "content": "Help me plan"}]},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "暂时无法生成回答，请稍后重试。"


def configure_actual_zhipu_transport(monkeypatch, body, *, streaming):
    from types import SimpleNamespace
    import httpx

    from app.services.llm import zhipu as zhipu_module
    from app.services.llm.service import ProviderType, llm_service

    transport = httpx.MockTransport(lambda _request: httpx.Response(
        200, content=body.encode(),
        headers={"content-type": "text/event-stream" if streaming else "application/json"},
    ))
    monkeypatch.setattr(
        zhipu_module, "httpx",
        SimpleNamespace(AsyncClient=lambda **kwargs: httpx.AsyncClient(transport=transport, **kwargs)),
    )
    monkeypatch.setattr(llm_service, "_providers", {
        ProviderType.ZHIPU: zhipu_module.ZhipuProvider(
            api_key="local-test-key", base_url="https://provider.invalid/v4", model="test-model",
        ),
    })
    monkeypatch.setattr(llm_service, "_current_provider", ProviderType.ZHIPU)


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["message", "stream"])
@pytest.mark.parametrize("failure", ["network_error", "length", "error_payload", "truncated"])
async def test_actual_zhipu_failures_do_not_persist_assistant_or_reward(client: AsyncClient, monkeypatch, endpoint, failure):
    username = f"zhipu-{endpoint}-{failure}"
    await register_user(client, username=username, email=f"{username}@example.com")
    token = await login(client, username=username)
    headers = {"Authorization": f"Bearer {token}"}
    if endpoint == "stream":
        body = 'data: {"choices":[{"delta":{"content":"provisional answer"}}]}\n\n'
        if failure == "error_payload":
            body += 'data: {"error":{"message":"private provider details"}}\n\n'
        elif failure != "truncated":
            body += "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": failure}]}) + "\n\n"
        if failure != "truncated":
            body += "data: [DONE]\n\n"
    elif failure == "error_payload":
        body = json.dumps({"error": {"message": "private provider details"}})
    elif failure == "truncated":
        body = '{"choices":[{"message":{"content":"private incomplete json'
    else:
        body = json.dumps({"choices": [{"message": {"content": "private unfinished text"}, "finish_reason": failure}]})
    configure_actual_zhipu_transport(monkeypatch, body, streaming=endpoint == "stream")

    response = await client.post(
        f"/api/v1/chat/{endpoint}", headers=headers,
        json={"message": "Give me a complete response", "pet_type": "pig"},
    )
    if endpoint == "message":
        assert response.status_code == 503
        assert response.json()["detail"] == "暂时无法生成回答，请稍后重试。"
    else:
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["done"] is True
        assert events[-1]["error"] == "provider_unavailable"
        assert events[-1]["message"] == "暂时无法生成回答，请稍后重试。"
    assert "private" not in response.text
    sessions = (await client.get("/api/v1/chat/sessions", headers=headers)).json()
    assert len(sessions) == 1
    assert [message["role"] for message in sessions[0]["messages"]] == ["user"]
    summary = (await client.get("/api/v1/pets/pig/daily-summary", headers=headers)).json()
    assert summary["meaningful_chat_count"] == 0
    assert summary["xp_gained"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["message", "stream"])
async def test_actual_zhipu_completed_answers_are_saved_and_counted(client: AsyncClient, monkeypatch, endpoint):
    username = f"zhipu-ok-{endpoint}"
    await register_user(client, username=username, email=f"{username}@example.com")
    token = await login(client, username=username)
    headers = {"Authorization": f"Bearer {token}"}
    choice = {"finish_reason": "stop", "delta" if endpoint == "stream" else "message": {"content": "完整回答"}}
    body = json.dumps({"choices": [choice]})
    if endpoint == "stream":
        body = f"data: {body}\n\ndata: [DONE]\n\n"
    configure_actual_zhipu_transport(monkeypatch, body, streaming=endpoint == "stream")

    response = await client.post(
        f"/api/v1/chat/{endpoint}", headers=headers,
        json={"message": "Give me a complete response", "pet_type": "pig"},
    )
    assert response.status_code == 200
    sessions = (await client.get("/api/v1/chat/sessions", headers=headers)).json()
    assert [message["content"] for message in sessions[0]["messages"] if message["role"] == "assistant"] == ["完整回答"]
    summary = (await client.get("/api/v1/pets/pig/daily-summary", headers=headers)).json()
    assert summary["meaningful_chat_count"] == 1
    assert summary["xp_gained"] > 0


@pytest.mark.asyncio
async def test_chat_session_metadata_mode_avoids_loading_histories(client: AsyncClient):
    from datetime import timedelta
    from sqlalchemy import event, select

    from app.core.time import utc_now
    from app.models.database import ChatMessage, ChatSession, User, async_session_maker, engine

    await register_user(client, username="historyowner", email="historyowner@example.com")
    token = await login(client, username="historyowner")
    headers = {"Authorization": f"Bearer {token}"}
    async with async_session_maker() as db:
        owner = (await db.execute(select(User).where(User.username == "historyowner"))).scalar_one()
        admin = (await db.execute(select(User).where(User.username == "admin"))).scalar_one()
        now = utc_now()
        older = ChatSession(user_id=owner.id, title="Older conversation", updated_at=now - timedelta(minutes=1))
        newer = ChatSession(user_id=owner.id, title="Newer conversation", updated_at=now)
        foreign = ChatSession(user_id=admin.id, title="Foreign conversation", updated_at=now + timedelta(minutes=1))
        db.add_all([older, newer, foreign])
        await db.flush()
        for session in [older, newer, foreign]:
            db.add_all([
                ChatMessage(session_id=session.id, role="user", content=f"Question for {session.title}"),
                ChatMessage(session_id=session.id, role="assistant", content=f"Answer for {session.title}"),
            ])
        await db.commit()
        expected_ids = [newer.id, older.id]
        foreign_id = foreign.id

    statements = []

    def record_query(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lower())

    event.listen(engine.sync_engine, "before_cursor_execute", record_query)
    try:
        response = await client.get("/api/v1/chat/sessions", headers=headers, params={"include_messages": "false"})
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_query)

    assert response.status_code == 200
    metadata = response.json()
    assert [session["id"] for session in metadata] == expected_ids
    assert [session["title"] for session in metadata] == ["Newer conversation", "Older conversation"]
    assert all(session["messages"] == [] for session in metadata)
    assert any("chat_sessions" in statement for statement in statements)
    assert not any("chat_messages" in statement for statement in statements)

    full = (await client.get("/api/v1/chat/sessions", headers=headers)).json()
    assert [session["id"] for session in full] == expected_ids
    assert all(len(session["messages"]) == 2 for session in full)
    detail = (await client.get(f"/api/v1/chat/sessions/{expected_ids[0]}", headers=headers)).json()
    assert detail["messages"] == full[0]["messages"]
    assert (await client.get(f"/api/v1/chat/sessions/{foreign_id}", headers=headers)).status_code == 404
