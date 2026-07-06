import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

TEST_ROOT = Path(__file__).resolve().parent / ".runtime-reminders"
if TEST_ROOT.exists():
    shutil.rmtree(TEST_ROOT)
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(TEST_ROOT / 'test.db').as_posix()}"
os.environ["CHROMA_PERSIST_DIR"] = str(TEST_ROOT / "chroma")
os.environ["UPLOAD_DIR"] = str(TEST_ROOT / "uploads")
os.environ["DOWNLOAD_DIR"] = str(TEST_ROOT / "downloads")
os.environ["SMTP_USER"] = ""
os.environ["SMTP_PASSWORD"] = ""
os.environ["INITIAL_ADMIN_USERNAME"] = "admin"
os.environ["INITIAL_ADMIN_EMAIL"] = "admin@example.com"
os.environ["INITIAL_ADMIN_PASSWORD"] = "ChangeThisPassword123!"

from app.core.time import utc_now  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas.reminder import ReminderCreate  # noqa: E402


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def register_and_login(client: AsyncClient, username: str, email: str) -> dict[str, str]:
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

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "email": email,
            "password": "Password123!",
            "verification_code": code.code,
        },
    )
    assert response.status_code == 200

    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": "Password123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.mark.asyncio
async def test_reminders_are_scoped_by_user_pet_and_status(client: AsyncClient):
    headers = await register_and_login(client, "reminderuser", "reminder@example.com")
    remind_at = (utc_now() + timedelta(hours=1)).isoformat()

    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "Afternoon meeting",
            "source_text": "Remind me about the afternoon meeting",
            "remind_at": remind_at,
        },
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    assert created.json()["pet_type"] == "pig"
    assert created.json()["status"] == "pending"

    pig_list = await client.get("/api/v1/reminders?pet_type=pig&status=pending", headers=headers)
    assert pig_list.status_code == 200
    assert [item["id"] for item in pig_list.json()] == [reminder_id]

    cat_list = await client.get("/api/v1/reminders?pet_type=cat&status=pending", headers=headers)
    assert cat_list.status_code == 200
    assert cat_list.json() == []

    summary = await client.get("/api/v1/reminders/pending-summary?pet_type=pig", headers=headers)
    assert summary.status_code == 200
    assert summary.json() == {"pet_type": "pig", "pending_count": 1}

    completed = await client.post(f"/api/v1/reminders/{reminder_id}/complete", headers=headers)
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["triggered_at"] is not None

    empty = await client.get("/api/v1/reminders?pet_type=pig&status=pending", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []


def test_reminder_schema_normalizes_aware_datetime_to_naive_utc():
    payload = ReminderCreate(
        pet_type="pig",
        title="Offset reminder",
        source_text="Timezone input",
        remind_at="2026-07-06T15:00:00+08:00",
    )

    assert payload.remind_at == datetime(2026, 7, 6, 7, 0, 0)
    assert payload.remind_at.tzinfo is None


@pytest.mark.asyncio
async def test_reminders_require_auth_and_can_be_canceled(client: AsyncClient):
    unauthenticated = await client.get("/api/v1/reminders?pet_type=pig&status=pending")
    assert unauthenticated.status_code == 401

    headers = await register_and_login(client, "cancel-reminders", "cancel-reminders@example.com")
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "cat",
            "title": "Cancel me",
            "source_text": "Create then cancel",
            "remind_at": (utc_now() + timedelta(hours=2)).isoformat(),
        },
    )
    assert created.status_code == 200

    canceled = await client.patch(
        f"/api/v1/reminders/{created.json()['id']}",
        headers=headers,
        json={"status": "canceled"},
    )
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"
    assert canceled.json()["completed_at"] is not None

    pending = await client.get("/api/v1/reminders?pet_type=cat&status=pending", headers=headers)
    assert pending.status_code == 200
    assert pending.json() == []


@pytest.mark.asyncio
async def test_due_before_accepts_z_timestamp(client: AsyncClient):
    headers = await register_and_login(client, "timezone-reminders", "timezone-reminders@example.com")
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "UTC reminder",
            "source_text": "UTC reminder",
            "remind_at": "2026-07-06T07:00:00Z",
        },
    )
    assert created.status_code == 200

    due = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending&due_before=2026-07-06T07:00:01Z",
        headers=headers,
    )
    assert due.status_code == 200
    assert [item["id"] for item in due.json()] == [created.json()["id"]]


@pytest.mark.asyncio
async def test_reminders_are_owned_by_current_user(client: AsyncClient):
    alice_headers = await register_and_login(client, "alice-reminders", "alice-reminders@example.com")
    bob_headers = await register_and_login(client, "bob-reminders", "bob-reminders@example.com")
    remind_at = (utc_now() + timedelta(minutes=30)).isoformat()

    created = await client.post(
        "/api/v1/reminders",
        headers=alice_headers,
        json={
            "pet_type": "dog",
            "title": "Alice only",
            "source_text": "Alice private reminder",
            "remind_at": remind_at,
        },
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]

    bob_list = await client.get("/api/v1/reminders?pet_type=dog&status=pending", headers=bob_headers)
    assert bob_list.status_code == 200
    assert bob_list.json() == []

    bob_complete = await client.post(f"/api/v1/reminders/{reminder_id}/complete", headers=bob_headers)
    assert bob_complete.status_code == 404
