import os
import shutil
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

TEST_ROOT = Path(__file__).resolve().parent / ".runtime"
if TEST_ROOT.exists():
    shutil.rmtree(TEST_ROOT)
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(TEST_ROOT / 'test.db').as_posix()}"
os.environ["CHROMA_PERSIST_DIR"] = str(TEST_ROOT / "chroma")
os.environ["UPLOAD_DIR"] = str(TEST_ROOT / "uploads")
os.environ["DOWNLOAD_DIR"] = str(TEST_ROOT / "downloads")
os.environ["INITIAL_ADMIN_USERNAME"] = "admin"
os.environ["INITIAL_ADMIN_EMAIL"] = "admin@example.com"
os.environ["INITIAL_ADMIN_PASSWORD"] = "ChangeThisPassword123!"

from app.main import app  # noqa: E402


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


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


@pytest.mark.asyncio
async def test_auth_preferences_and_password_reset(client: AsyncClient):
    await register_user(client, username="alice", email="alice@example.com")

    token = await login(client, username="alice")
    headers = {"Authorization": f"Bearer {token}"}

    me_response = await client.get("/api/v1/auth/me", headers=headers)
    assert me_response.status_code == 200
    assert me_response.json()["preferences"]["pet_type"] == "cat"

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
async def test_register_rejects_existing_email_and_chat_accepts_pet_type(client: AsyncClient):
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
async def test_admin_disable_user_and_rag_isolation(client: AsyncClient):
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
