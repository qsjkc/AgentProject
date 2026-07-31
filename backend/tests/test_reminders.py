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
    assert created.json()["email_enabled"] is True
    assert created.json()["email_status"] == "pending"
    assert created.json()["email_sent_at"] is None
    assert created.json()["email_attempt_count"] == 0

    relationship_after_create = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship_after_create.status_code == 200
    assert relationship_after_create.json()["intimacy_xp"] == 4

    pig_list = await client.get("/api/v1/reminders?pet_type=pig&status=pending", headers=headers)
    assert pig_list.status_code == 200
    assert [item["id"] for item in pig_list.json()] == [reminder_id]

    cat_list = await client.get("/api/v1/reminders?pet_type=cat&status=pending", headers=headers)
    assert cat_list.status_code == 200
    assert cat_list.json() == []

    summary = await client.get("/api/v1/reminders/pending-summary?pet_type=pig", headers=headers)
    assert summary.status_code == 200
    assert summary.json() == {"pet_type": "pig", "pending_count": 1}

    triggered = await client.post(f"/api/v1/reminders/{reminder_id}/trigger", headers=headers)
    assert triggered.status_code == 200
    assert triggered.json()["status"] == "pending"
    assert triggered.json()["triggered_at"] is not None

    relationship_after_trigger = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship_after_trigger.status_code == 200
    assert relationship_after_trigger.json()["intimacy_xp"] == 4

    undelivered = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending&triggered=false",
        headers=headers,
    )
    assert undelivered.status_code == 200
    assert undelivered.json() == []

    awaiting_completion = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending&triggered=true",
        headers=headers,
    )
    assert awaiting_completion.status_code == 200
    assert [item["id"] for item in awaiting_completion.json()] == [reminder_id]

    completed = await client.post(f"/api/v1/reminders/{reminder_id}/complete", headers=headers)
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["triggered_at"] is not None
    assert completed.json()["email_status"] == "canceled"

    relationship_after_complete = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship_after_complete.status_code == 200
    assert relationship_after_complete.json()["intimacy_xp"] == 14

    completed_again = await client.post(
        f"/api/v1/reminders/{reminder_id}/complete",
        headers=headers,
    )
    assert completed_again.status_code == 200
    relationship_after_duplicate = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship_after_duplicate.json()["intimacy_xp"] == 14

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


def test_reminder_email_escapes_html_and_removes_subject_newlines():
    from app.services.reminder_delivery import (  # noqa: E402
        ClaimedReminder,
        build_reminder_email,
    )

    claimed = ClaimedReminder(
        id=1,
        claim_token="test-claim",
        recipient="safe@example.com",
        username="<用户>",
        pet_type="pig",
        title="开会 <确认>\n下一行",
        remind_at=datetime(2026, 7, 31, 7, 0, 0),
        attempt_count=1,
    )

    subject, html_content = build_reminder_email(claimed)

    assert subject == "小猪提醒你：开会 <确认> 下一行"
    assert "\n" not in subject
    assert "&lt;用户&gt;" in html_content
    assert "开会 &lt;确认&gt;\n下一行" in html_content


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
    assert canceled.json()["email_status"] == "canceled"

    relationship = await client.get(
        "/api/v1/pets/cat/relationship",
        headers=headers,
    )
    assert relationship.status_code == 200
    assert relationship.json()["intimacy_xp"] == 4

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
        "/api/v1/reminders?pet_type=pig&status=pending&due_before=2026-07-06T07:00:01Z&triggered=false",
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


@pytest.mark.asyncio
async def test_due_reminder_email_is_sent_without_marking_desktop_triggered(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(
        client,
        "email-delivery",
        "email-delivery@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "下午三点开会",
            "source_text": "下午三点有一个会议",
            "remind_at": (utc_now() - timedelta(minutes=1)).isoformat(),
        },
    )
    reminder_id = created.json()["id"]
    deliveries = []

    async def capture_email(recipient: str, subject: str, html_content: str) -> bool:
        deliveries.append((recipient, subject, html_content))
        return True

    from app.services import reminder_delivery as reminder_delivery_module  # noqa: E402

    monkeypatch.setattr(reminder_delivery_module, "send_email", capture_email)
    processed = await reminder_delivery_module.reminder_delivery_service.process_due_once()

    assert processed >= 1
    assert any(
        recipient == "email-delivery@example.com"
        and subject == "小猪提醒你：下午三点开会"
        and "桌面端继续等你回来处理" in content
        for recipient, subject, content in deliveries
    )

    reminders = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending",
        headers=headers,
    )
    delivered = next(item for item in reminders.json() if item["id"] == reminder_id)
    assert delivered["email_status"] == "sent"
    assert delivered["email_sent_at"] is not None
    assert delivered["email_attempt_count"] == 1
    assert delivered["triggered_at"] is None

    rescheduled = await client.patch(
        f"/api/v1/reminders/{reminder_id}",
        headers=headers,
        json={"remind_at": (utc_now() + timedelta(hours=1)).isoformat()},
    )
    assert rescheduled.status_code == 200
    assert rescheduled.json()["email_status"] == "pending"
    assert rescheduled.json()["email_sent_at"] is None
    assert rescheduled.json()["email_attempt_count"] == 0


@pytest.mark.asyncio
async def test_reminder_email_retries_then_stops_at_attempt_limit(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(
        client,
        "email-retry",
        "email-retry@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "重试发送",
            "remind_at": (utc_now() - timedelta(minutes=1)).isoformat(),
        },
    )
    reminder_id = created.json()["id"]

    from app.core.config import settings  # noqa: E402
    from app.models.database import Reminder, async_session_maker  # noqa: E402
    from app.services import reminder_delivery as reminder_delivery_module  # noqa: E402
    from app.services.email import EmailDeliveryError  # noqa: E402

    async def fail_email(*_args) -> bool:
        raise EmailDeliveryError("SMTP delivery failed: test")

    monkeypatch.setattr(settings, "REMINDER_EMAIL_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(settings, "REMINDER_EMAIL_RETRY_BASE_SECONDS", 60)
    monkeypatch.setattr(reminder_delivery_module, "send_email", fail_email)

    await reminder_delivery_module.reminder_delivery_service.process_due_once()
    first = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending",
        headers=headers,
    )
    retrying = next(item for item in first.json() if item["id"] == reminder_id)
    assert retrying["email_status"] == "retrying"
    assert retrying["email_attempt_count"] == 1

    async with async_session_maker.begin() as session:
        reminder = await session.get(Reminder, reminder_id)
        reminder.email_next_attempt_at = utc_now() - timedelta(seconds=1)

    await reminder_delivery_module.reminder_delivery_service.process_due_once()
    second = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending",
        headers=headers,
    )
    failed = next(item for item in second.json() if item["id"] == reminder_id)
    assert failed["email_status"] == "failed"
    assert failed["email_attempt_count"] == 2

    retry = await client.patch(
        f"/api/v1/reminders/{reminder_id}",
        headers=headers,
        json={"email_enabled": True},
    )
    assert retry.status_code == 200
    assert retry.json()["email_status"] == "pending"
    assert retry.json()["email_attempt_count"] == 0


@pytest.mark.asyncio
async def test_reminder_can_disable_email_delivery(client: AsyncClient):
    headers = await register_and_login(
        client,
        "email-disabled",
        "email-disabled@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "只在桌面提醒",
            "remind_at": (utc_now() + timedelta(hours=1)).isoformat(),
            "email_enabled": False,
        },
    )

    assert created.status_code == 200
    assert created.json()["email_enabled"] is False
    assert created.json()["email_status"] == "disabled"


@pytest.mark.asyncio
async def test_exhausted_stale_email_claim_becomes_failed(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(
        client,
        "email-stale-claim",
        "email-stale-claim@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "恢复悬挂发送",
            "remind_at": (utc_now() - timedelta(minutes=10)).isoformat(),
        },
    )
    reminder_id = created.json()["id"]

    from app.core.config import settings  # noqa: E402
    from app.models.database import Reminder, async_session_maker  # noqa: E402
    from app.services.reminder_delivery import reminder_delivery_service  # noqa: E402

    monkeypatch.setattr(settings, "REMINDER_EMAIL_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(settings, "REMINDER_EMAIL_LEASE_SECONDS", 300)
    async with async_session_maker.begin() as session:
        reminder = await session.get(Reminder, reminder_id)
        reminder.email_status = "sending"
        reminder.email_attempt_count = 3
        reminder.email_claimed_at = utc_now() - timedelta(minutes=6)
        reminder.email_claim_token = "stale-final-claim"

    await reminder_delivery_service.process_due_once()
    reminders = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending",
        headers=headers,
    )
    recovered = next(item for item in reminders.json() if item["id"] == reminder_id)
    assert recovered["email_status"] == "failed"
    assert recovered["email_attempt_count"] == 3
