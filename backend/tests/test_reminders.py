import asyncio
from datetime import datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

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
    # Desktop delivery only acknowledges reminders that are already due.
    remind_at = (utc_now() - timedelta(minutes=1)).isoformat()

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


@pytest.mark.asyncio
async def test_daily_reminder_creates_series_and_materializes_independent_occurrence(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(
        client,
        "daily-series",
        "daily-series@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "喝水",
            "source_text": "每天上午九点提醒我喝水",
            "remind_at": (utc_now() + timedelta(days=1)).isoformat(),
            "recurrence_type": "daily",
            "recurrence_timezone": "Asia/Shanghai",
        },
    )
    assert created.status_code == 200
    first = created.json()
    assert first["series_id"] is not None
    assert first["recurrence_type"] == "daily"
    assert first["occurrence_sequence"] == 1
    assert first["creation_source"] == "user"
    assert first["remind_at"].endswith("Z")

    series_list = await client.get(
        "/api/v1/reminder-series?pet_type=pig&status=active",
        headers=headers,
    )
    assert series_list.status_code == 200
    series = next(item for item in series_list.json() if item["id"] == first["series_id"])
    assert series["recurrence_type"] == "daily"
    assert series["timezone"] == "Asia/Shanghai"
    assert series["weekdays"] == [0, 1, 2, 3, 4, 5, 6]
    assert series["next_occurrence_at"].endswith("Z")

    from app.core.config import settings  # noqa: E402
    from app.models.database import ReminderSeries, async_session_maker  # noqa: E402
    from app.services.reminder_recurrence import reminder_recurrence_service  # noqa: E402

    monkeypatch.setattr(settings, "REMINDER_RECURRENCE_LOOKAHEAD_SECONDS", 60)
    async with async_session_maker.begin() as session:
        stored_series = await session.get(ReminderSeries, first["series_id"])
        stored_series.next_occurrence_at = utc_now() + timedelta(seconds=30)

    materialized = await reminder_recurrence_service.process_due_once()
    assert materialized >= 1

    reminders = await client.get(
        "/api/v1/reminders?pet_type=pig&status=pending",
        headers=headers,
    )
    occurrences = [
        item for item in reminders.json()
        if item["series_id"] == first["series_id"]
    ]
    assert [item["occurrence_sequence"] for item in occurrences] == [2, 1]
    generated = next(item for item in occurrences if item["occurrence_sequence"] == 2)
    assert generated["creation_source"] == "recurrence"
    assert generated["email_status"] == "pending"

    relationship = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship.json()["intimacy_xp"] == 4

    completed = await client.post(
        f"/api/v1/reminders/{generated['id']}/complete",
        headers=headers,
    )
    assert completed.status_code == 200
    assert completed.json()["occurrence_sequence"] == 2
    relationship_after_completion = await client.get(
        "/api/v1/pets/pig/relationship",
        headers=headers,
    )
    assert relationship_after_completion.json()["intimacy_xp"] == 14

    daily_summary = await client.get(
        "/api/v1/pets/pig/daily-summary",
        headers=headers,
    )
    assert daily_summary.json()["reminders_created_count"] == 1
    assert daily_summary.json()["reminders_completed_count"] == 1


@pytest.mark.asyncio
async def test_paused_series_restores_future_occurrence_and_cancel_stops_it(
    client: AsyncClient,
):
    headers = await register_and_login(
        client,
        "series-controls",
        "series-controls@example.com",
    )
    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "工作日报",
            "remind_at": (utc_now() + timedelta(days=1)).isoformat(),
            "recurrence_type": "weekdays",
            "recurrence_timezone": "Asia/Shanghai",
        },
    )
    reminder_id = created.json()["id"]
    series_id = created.json()["series_id"]

    paused = await client.post(
        f"/api/v1/reminder-series/{series_id}/pause",
        headers=headers,
    )
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    paused_occurrence = await client.get(
        f"/api/v1/reminders?pet_type=pig",
        headers=headers,
    )
    paused_item = next(item for item in paused_occurrence.json() if item["id"] == reminder_id)
    assert paused_item["status"] == "canceled"
    assert paused_item["cancellation_source"] == "series_pause"

    resumed = await client.post(
        f"/api/v1/reminder-series/{series_id}/resume",
        headers=headers,
    )
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "active"

    resumed_occurrence = await client.get(
        f"/api/v1/reminders?pet_type=pig",
        headers=headers,
    )
    resumed_item = next(item for item in resumed_occurrence.json() if item["id"] == reminder_id)
    assert resumed_item["status"] == "pending"
    assert resumed_item["cancellation_source"] is None

    paused_again = await client.post(
        f"/api/v1/reminder-series/{series_id}/pause",
        headers=headers,
    )
    assert paused_again.status_code == 200

    canceled = await client.post(
        f"/api/v1/reminder-series/{series_id}/cancel",
        headers=headers,
    )
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"

    canceled_occurrence = await client.get(
        f"/api/v1/reminders?pet_type=pig",
        headers=headers,
    )
    canceled_item = next(item for item in canceled_occurrence.json() if item["id"] == reminder_id)
    assert canceled_item["status"] == "canceled"
    assert canceled_item["cancellation_source"] == "series_cancel"


def test_weekly_recurrence_keeps_local_weekday_and_time():
    from app.services.reminder_recurrence import (  # noqa: E402
        calculate_next_occurrence,
        normalize_first_occurrence,
    )

    first, hour, minute, weekdays = normalize_first_occurrence(
        datetime(2026, 8, 3, 7, 0, 0),
        recurrence_type="weekly",
        timezone_name="Asia/Shanghai",
        now=datetime(2026, 7, 31, 0, 0, 0),
    )
    following = calculate_next_occurrence(
        first,
        local_hour=hour,
        local_minute=minute,
        timezone_name="Asia/Shanghai",
        weekdays=weekdays,
    )

    assert first == datetime(2026, 8, 3, 7, 0, 0)
    assert following == datetime(2026, 8, 10, 7, 0, 0)
    assert weekdays == [0]


@pytest.mark.asyncio
async def test_rescheduled_and_reopened_reminders_can_notify_desktop_again(client: AsyncClient):
    headers = await register_and_login(client, "reschedule-desktop", "reschedule-desktop@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "改期", "email_enabled": False,
              "remind_at": (utc_now() - timedelta(minutes=1)).isoformat()},
    )
    reminder_id = created.json()["id"]
    await client.post(f"/api/v1/reminders/{reminder_id}/trigger", headers=headers)
    future = utc_now() + timedelta(hours=1)
    rescheduled = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers,
        json={"remind_at": future.isoformat()},
    )
    assert rescheduled.status_code == 200
    assert rescheduled.json()["triggered_at"] is None
    waiting = await client.get(
        "/api/v1/reminders", headers=headers,
        params={"pet_type": "pig", "status": "pending", "triggered": "false",
                "due_before": future.isoformat()},
    )
    assert [item["id"] for item in waiting.json()] == [reminder_id]

    completed = await client.post(f"/api/v1/reminders/{reminder_id}/complete", headers=headers)
    assert completed.json()["triggered_at"] is not None
    reopened = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers, json={"status": "pending"},
    )
    assert reopened.json()["triggered_at"] is None
    assert reopened.json()["completed_at"] is None


@pytest.mark.asyncio
async def test_repeated_patch_preserves_sent_email_and_completion_time(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(client, "idempotent-patch", "idempotent-patch@example.com")
    from app.models.database import Reminder, async_session_maker
    from app.api.v1 import reminders as reminders_api

    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "重复保存", "remind_at": utc_now().isoformat()},
    )
    reminder_id = created.json()["id"]
    sent_at = utc_now() - timedelta(seconds=1)
    async with async_session_maker.begin() as session:
        reminder = await session.get(Reminder, reminder_id)
        reminder.email_status = "sent"
        reminder.email_sent_at = sent_at
        reminder.email_attempt_count = 1
    unchanged = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers,
        json={"remind_at": created.json()["remind_at"], "status": "pending"},
    )
    assert unchanged.json()["email_status"] == "sent"
    assert unchanged.json()["email_sent_at"] is not None
    assert unchanged.json()["email_attempt_count"] == 1

    completed = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers, json={"status": "completed"},
    )
    assert completed.json()["triggered_at"] is not None
    monkeypatch.setattr(reminders_api, "utc_now", lambda: utc_now() + timedelta(days=1))
    repeated = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers, json={"status": "completed"},
    )
    assert repeated.json()["completed_at"] == completed.json()["completed_at"]


@pytest.mark.asyncio
async def test_saving_unchanged_reminder_preserves_inflight_email_claim(client: AsyncClient):
    headers = await register_and_login(client, "unchanged-email-claim", "unchanged-email-claim@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "保存发送中的提醒", "remind_at": utc_now().isoformat()},
    )
    reminder_id = created.json()["id"]
    from app.models.database import Reminder, async_session_maker

    async with async_session_maker.begin() as session:
        reminder = await session.get(Reminder, reminder_id)
        reminder.email_status = "sending"
        reminder.email_claimed_at = utc_now()
        reminder.email_claim_token = "active-email-claim"
        reminder.email_attempt_count = 1
    saved = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers,
        json={"remind_at": created.json()["remind_at"], "email_enabled": True, "status": "pending"},
    )
    assert saved.status_code == 200
    assert saved.json()["email_status"] == "sending"
    async with async_session_maker() as session:
        reminder = await session.get(Reminder, reminder_id)
        assert reminder.email_claim_token == "active-email-claim"
        assert reminder.email_attempt_count == 1


@pytest.mark.asyncio
async def test_resume_series_skips_unmaterialized_occurrences_during_pause(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(client, "resume-no-backlog", "resume-no-backlog@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "暂停期间不打扰", "email_enabled": False,
              "remind_at": (utc_now() + timedelta(days=1)).isoformat(),
              "recurrence_type": "daily", "recurrence_timezone": "Asia/Shanghai"},
    )
    series_id = created.json()["series_id"]
    await client.post(f"/api/v1/reminder-series/{series_id}/pause", headers=headers)
    from app.models.database import ReminderSeries, async_session_maker
    from app.api.v1 import reminder_series as series_api
    from app.services import reminder_recurrence as recurrence_module

    now = datetime(2026, 9, 25, 8, 0)
    monkeypatch.setattr(series_api, "utc_now", lambda: now)
    monkeypatch.setattr(recurrence_module, "utc_now", lambda: now)
    async with async_session_maker.begin() as session:
        series = await session.get(ReminderSeries, series_id)
        series.next_occurrence_at = now - timedelta(hours=1)
        series.local_hour = 15
        series.local_minute = 0
    resumed = await client.post(f"/api/v1/reminder-series/{series_id}/resume", headers=headers)
    assert resumed.status_code == 200
    assert resumed.json()["next_occurrence_at"] == "2026-09-26T07:00:00Z"
    assert resumed.json()["next_sequence"] == 3
    assert resumed.json()["skipped_occurrence_count"] == 1
    await recurrence_module.reminder_recurrence_service.process_due_once()
    occurrences = await client.get("/api/v1/reminders", headers=headers)
    assert [item["occurrence_sequence"] for item in occurrences.json()] == [1]


@pytest.mark.parametrize("recurrence_type", ["daily", "weekdays", "weekly"])
def test_resuming_years_later_preserves_sequence_and_local_schedule(recurrence_type):
    from app.models.database import ReminderSeries
    from app.services.reminder_recurrence import calculate_next_occurrence, skip_paused_occurrences

    weekdays = {"daily": list(range(7)), "weekdays": list(range(5)), "weekly": [0]}[recurrence_type]
    series = ReminderSeries(
        timezone="America/New_York", local_hour=9, local_minute=15, weekdays=weekdays,
        next_occurrence_at=datetime(2020, 1, 6, 14, 15), next_sequence=2,
        skipped_occurrence_count=0,
    )
    now = datetime(2026, 9, 25, 14, 0)
    expected_next = series.next_occurrence_at
    skipped = 0
    while expected_next <= now:
        expected_next = calculate_next_occurrence(
            expected_next, local_hour=9, local_minute=15,
            timezone_name=series.timezone, weekdays=weekdays,
        )
        skipped += 1
    skip_paused_occurrences(series, now=now)
    assert series.next_occurrence_at == expected_next
    assert series.next_sequence == 2 + skipped
    assert series.skipped_occurrence_count == skipped


@pytest.mark.asyncio
async def test_concurrent_email_workers_cannot_claim_the_same_due_reminder(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    headers = await register_and_login(client, "concurrent-email", "concurrent-email@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "只领取一次", "remind_at": "1900-01-01T00:00:00Z"},
    )
    reminder_id = created.json()["id"]
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from app.models.database import Reminder, async_session_maker, engine
    from app.services import reminder_delivery as delivery_module

    selected = 0
    both_selected = asyncio.Event()

    class ConcurrentClaimSession(AsyncSession):
        async def execute(self, statement, *args, **kwargs):
            nonlocal selected
            result = await super().execute(statement, *args, **kwargs)
            if statement.is_select:
                selected += 1
                if selected == 2:
                    both_selected.set()
                await asyncio.wait_for(both_selected.wait(), timeout=5)
            return result

    monkeypatch.setattr(
        delivery_module, "async_session_maker",
        async_sessionmaker(engine, class_=ConcurrentClaimSession, expire_on_commit=False),
    )
    workers = [delivery_module.ReminderDeliveryService(), delivery_module.ReminderDeliveryService()]
    claims = await asyncio.gather(*(worker._claim_next_due() for worker in workers))
    active_claims = [claim for claim in claims if claim is not None]
    assert len(active_claims) == 1
    assert active_claims[0].id == reminder_id
    async with async_session_maker() as session:
        stored = await session.get(Reminder, reminder_id)
        assert stored.email_claim_token == active_claims[0].claim_token
        assert stored.email_attempt_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", [True, False])
async def test_email_completion_cannot_overwrite_a_concurrent_cancellation(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, sent: bool,
):
    username = f"cancel-email-race-{sent}"
    headers = await register_and_login(client, username, f"{username}@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "取消后不要重试", "remind_at": "1899-01-01T00:00:00Z"},
    )
    reminder_id = created.json()["id"]
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from app.models.database import Reminder, async_session_maker, engine
    from app.services import reminder_delivery as delivery_module
    from app.services.email import EmailDeliveryError
    from app.services.reminder_state import stop_email_delivery

    worker = delivery_module.ReminderDeliveryService()
    claim = await worker._claim_next_due()
    assert claim.id == reminder_id

    async def cancel_before_write():
        async with async_session_maker.begin() as session:
            reminder = await session.get(Reminder, reminder_id)
            reminder.status = "canceled"
            stop_email_delivery(reminder)

    class ConcurrentCancelSession(AsyncSession):
        async def execute(self, statement, *args, **kwargs):
            if statement.is_select:
                result = await super().execute(statement, *args, **kwargs)
                await cancel_before_write()
                return result
            await cancel_before_write()
            return await super().execute(statement, *args, **kwargs)

    monkeypatch.setattr(
        delivery_module, "async_session_maker",
        async_sessionmaker(engine, class_=ConcurrentCancelSession, expire_on_commit=False),
    )
    if sent:
        await worker._mark_sent(claim)
    else:
        await worker._mark_failed_attempt(claim, EmailDeliveryError("delivery failed"))
    async with async_session_maker() as session:
        stored = await session.get(Reminder, reminder_id)
        assert stored.status == "canceled"
        assert stored.email_status == "canceled"
        assert stored.email_sent_at is None
        assert stored.email_claim_token is None
        assert stored.email_next_attempt_at is None


@pytest.mark.asyncio
async def test_trigger_rejects_late_acknowledgement_after_rescheduling(client: AsyncClient):
    headers = await register_and_login(client, "late-trigger-reschedule", "late-trigger-reschedule@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "稍后喝水", "email_enabled": False,
              "remind_at": (utc_now() - timedelta(minutes=1)).isoformat()},
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    # An earlier poll has already captured this ID, but its acknowledgement is late.
    due = await client.get(
        "/api/v1/reminders", headers=headers,
        params={"pet_type": "pig", "status": "pending", "triggered": "false", "due_before": utc_now().isoformat()},
    )
    assert [item["id"] for item in due.json()] == [reminder_id]
    future = utc_now() + timedelta(hours=1)
    rescheduled = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers,
        json={"remind_at": future.isoformat()},
    )
    assert rescheduled.status_code == 200
    assert rescheduled.json()["triggered_at"] is None
    assert rescheduled.json()["title"] == created.json()["title"]

    late = await client.post(f"/api/v1/reminders/{reminder_id}/trigger", headers=headers)
    assert late.status_code == 409
    waiting = await client.get(
        "/api/v1/reminders", headers=headers,
        params={"pet_type": "pig", "status": "pending", "triggered": "false"},
    )
    assert [item["id"] for item in waiting.json()] == [reminder_id]
    assert waiting.json()[0]["remind_at"] == rescheduled.json()["remind_at"]
    assert waiting.json()[0]["triggered_at"] is None


@pytest.mark.asyncio
async def test_trigger_rejects_late_acknowledgement_after_cancellation(client: AsyncClient):
    headers = await register_and_login(client, "late-trigger-cancel", "late-trigger-cancel@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "取消这次提醒",
              "remind_at": (utc_now() - timedelta(minutes=1)).isoformat()},
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    canceled = await client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers, json={"status": "canceled"},
    )
    assert canceled.status_code == 200
    late = await client.post(f"/api/v1/reminders/{reminder_id}/trigger", headers=headers)
    assert late.status_code == 409
    rows = await client.get("/api/v1/reminders", headers=headers)
    assert len(rows.json()) == 1
    assert rows.json()[0]["status"] == "canceled"
    assert rows.json()[0]["triggered_at"] is None
    assert rows.json()[0]["completed_at"] == canceled.json()["completed_at"]
    assert rows.json()[0]["email_status"] == "canceled"


@pytest.mark.asyncio
async def test_trigger_is_due_owned_and_idempotent(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    from app.api.v1 import reminders as reminders_api

    alice = await register_and_login(client, "trigger-owner", "trigger-owner@example.com")
    bob = await register_and_login(client, "trigger-other", "trigger-other@example.com")
    captured_now = utc_now()
    monkeypatch.setattr(reminders_api, "utc_now", lambda: captured_now)
    created = await client.post(
        "/api/v1/reminders", headers=alice,
        json={"pet_type": "pig", "title": "现在喝水", "email_enabled": False,
              "remind_at": captured_now.isoformat()},
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    path = f"/api/v1/reminders/{reminder_id}/trigger"
    assert (await client.post(path)).status_code == 401
    assert (await client.post(path, headers=bob)).status_code == 404
    before = await client.get("/api/v1/reminders", headers=alice)
    assert before.json()[0]["triggered_at"] is None

    triggered = await client.post(path, headers=alice)
    assert triggered.status_code == 200
    assert triggered.json()["status"] == "pending"
    assert triggered.json()["triggered_at"] == captured_now.isoformat() + "Z"
    monkeypatch.setattr(reminders_api, "utc_now", lambda: captured_now + timedelta(minutes=5))
    repeated = await client.post(path, headers=alice)
    assert repeated.status_code == 200
    assert repeated.json()["triggered_at"] == triggered.json()["triggered_at"]
    assert repeated.json()["updated_at"] == triggered.json()["updated_at"]
    assert (await client.post(path, headers=bob)).status_code == 404


@pytest.mark.asyncio
async def test_reschedule_clears_trigger_committed_after_its_initial_read(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    from app.api.v1 import reminders as reminders_api

    headers = await register_and_login(client, "reschedule-trigger-race", "reschedule-trigger-race@example.com")
    created = await client.post(
        "/api/v1/reminders", headers=headers,
        json={"pet_type": "pig", "title": "改期与触发交错", "email_enabled": False,
              "remind_at": (utc_now() - timedelta(minutes=1)).isoformat()},
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    original_get_owned = reminders_api.get_owned_reminder
    patch_read = asyncio.Event()
    release_patch = asyncio.Event()
    paused = False

    async def hold_first_read(requested_id, current_user, db):
        nonlocal paused
        reminder = await original_get_owned(requested_id, current_user, db)
        if requested_id == reminder_id and not paused:
            paused = True
            assert reminder.triggered_at is None
            patch_read.set()
            await asyncio.wait_for(release_patch.wait(), timeout=5)
        return reminder

    monkeypatch.setattr(reminders_api, "get_owned_reminder", hold_first_read)
    future = utc_now() + timedelta(hours=1)
    changing = asyncio.create_task(client.patch(
        f"/api/v1/reminders/{reminder_id}", headers=headers,
        json={"remind_at": future.isoformat()},
    ))
    try:
        await asyncio.wait_for(patch_read.wait(), timeout=5)
        triggered = await client.post(f"/api/v1/reminders/{reminder_id}/trigger", headers=headers)
        assert triggered.status_code == 200
        assert triggered.json()["triggered_at"] is not None
    finally:
        release_patch.set()
        rescheduled = await asyncio.wait_for(changing, timeout=5)
    assert rescheduled.status_code == 200
    assert rescheduled.json()["triggered_at"] is None
    waiting = await client.get(
        "/api/v1/reminders", headers=headers,
        params={"status": "pending", "triggered": "false"},
    )
    assert [item["id"] for item in waiting.json()] == [reminder_id]
    assert waiting.json()[0]["remind_at"] == rescheduled.json()["remind_at"]
