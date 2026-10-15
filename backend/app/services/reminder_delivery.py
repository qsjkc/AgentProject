import asyncio
import html
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import or_, select, update

from app.core.config import settings
from app.core.logging import logger
from app.core.time import utc_now
from app.models.database import Reminder, User, async_session_maker
from app.services.email import EmailDeliveryError, send_email


@dataclass(frozen=True)
class ClaimedReminder:
    id: int
    claim_token: str
    recipient: str
    username: str
    pet_type: str
    title: str
    remind_at: datetime
    attempt_count: int


PET_NAMES = {
    "cat": "小猫",
    "dog": "小狗",
    "pig": "小猪",
}


class ReminderDeliveryService:
    def __init__(self) -> None:
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def startup(self) -> None:
        if not settings.REMINDER_EMAIL_WORKER_ENABLED:
            logger.info("Reminder email worker disabled by configuration")
            return
        if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
            logger.warning("Reminder email worker not started because SMTP credentials are missing")
            return
        if self._task and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(
            self._run(),
            name="reminder-email-delivery",
        )
        logger.info("Reminder email worker started")

    async def shutdown(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        await self._task
        self._task = None
        logger.info("Reminder email worker stopped")

    async def _run(self) -> None:
        interval = max(1, settings.REMINDER_EMAIL_POLL_INTERVAL_SECONDS)
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
                continue
            except TimeoutError:
                pass

            try:
                await self.process_due_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Reminder email delivery cycle failed")

    async def process_due_once(self) -> int:
        if self._stop_event.is_set():
            return 0
        await self._expire_exhausted_claims()
        processed = 0
        for _ in range(max(1, settings.REMINDER_EMAIL_BATCH_SIZE)):
            if self._stop_event.is_set():
                break
            claimed = await self._claim_next_due()
            if claimed is None:
                break
            if not await self._claim_is_active(claimed):
                continue

            subject, html_content = build_reminder_email(claimed)
            try:
                await send_email(claimed.recipient, subject, html_content)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._mark_failed_attempt(claimed, exc)
            else:
                await self._mark_sent(claimed)
            processed += 1
        return processed

    async def _expire_exhausted_claims(self) -> None:
        stale_before = utc_now() - timedelta(
            seconds=max(1, settings.REMINDER_EMAIL_LEASE_SECONDS)
        )
        async with async_session_maker.begin() as session:
            await session.execute(
                update(Reminder)
                .where(
                    Reminder.status == "pending",
                    Reminder.email_status == "sending",
                    Reminder.email_sent_at.is_(None),
                    Reminder.email_attempt_count
                    >= max(1, settings.REMINDER_EMAIL_MAX_ATTEMPTS),
                    or_(
                        Reminder.email_claimed_at.is_(None),
                        Reminder.email_claimed_at <= stale_before,
                    ),
                )
                .values(
                    email_status="failed",
                    email_claimed_at=None,
                    email_claim_token=None,
                    email_next_attempt_at=None,
                    email_last_error="Delivery lease expired after final attempt",
                )
            )

    async def _claim_next_due(self) -> ClaimedReminder | None:
        now = utc_now()
        stale_before = now - timedelta(
            seconds=max(1, settings.REMINDER_EMAIL_LEASE_SECONDS)
        )
        claim_token = str(uuid4())

        async with async_session_maker.begin() as session:
            eligible = (
                Reminder.status == "pending",
                Reminder.email_enabled.is_(True),
                Reminder.email_sent_at.is_(None),
                Reminder.email_status.in_(("pending", "retrying", "sending")),
                Reminder.remind_at <= now,
                Reminder.email_attempt_count
                < max(1, settings.REMINDER_EMAIL_MAX_ATTEMPTS),
                or_(
                    Reminder.email_next_attempt_at.is_(None),
                    Reminder.email_next_attempt_at <= now,
                ),
                or_(
                    Reminder.email_claimed_at.is_(None),
                    Reminder.email_claimed_at <= stale_before,
                ),
            )
            query = (
                select(Reminder, User.email, User.username)
                .join(User, User.id == Reminder.user_id)
                .where(*eligible)
                .order_by(Reminder.remind_at.asc(), Reminder.id.asc())
                .limit(1)
                .with_for_update(skip_locked=True, of=Reminder)
            )
            row = (await session.execute(query)).first()
            if row is None:
                return None

            reminder, recipient, username = row
            # SQLite ignores FOR UPDATE. Recheck eligibility atomically so a
            # second worker cannot replace a live claim after the initial read.
            result = await session.execute(
                update(Reminder)
                .where(Reminder.id == reminder.id, *eligible)
                .values(
                    email_status="sending",
                    email_claimed_at=now,
                    email_claim_token=claim_token,
                    email_attempt_count=Reminder.email_attempt_count + 1,
                    email_next_attempt_at=None,
                    email_last_error=None,
                )
                .returning(Reminder.email_attempt_count)
                .execution_options(synchronize_session=False)
            )
            attempt_count = result.scalar_one_or_none()
            if attempt_count is None:
                return None
            return ClaimedReminder(
                id=reminder.id,
                claim_token=claim_token,
                recipient=recipient,
                username=username,
                pet_type=reminder.pet_type,
                title=reminder.title,
                remind_at=reminder.remind_at,
                attempt_count=attempt_count,
            )

    async def _claim_is_active(self, claimed: ClaimedReminder) -> bool:
        async with async_session_maker() as session:
            result = await session.execute(
                select(Reminder.id).where(
                    Reminder.id == claimed.id,
                    Reminder.status == "pending",
                    Reminder.email_status == "sending",
                    Reminder.email_claim_token == claimed.claim_token,
                )
            )
            return result.scalar_one_or_none() is not None

    async def _mark_sent(self, claimed: ClaimedReminder) -> None:
        async with async_session_maker.begin() as session:
            await session.execute(
                self._claimed_update(claimed).values(
                    email_status="sent",
                    email_sent_at=utc_now(),
                    email_claimed_at=None,
                    email_claim_token=None,
                    email_next_attempt_at=None,
                    email_last_error=None,
                )
            )

    async def _mark_failed_attempt(
        self,
        claimed: ClaimedReminder,
        error: Exception,
    ) -> None:
        async with async_session_maker.begin() as session:
            max_attempts = max(1, settings.REMINDER_EMAIL_MAX_ATTEMPTS)
            if claimed.attempt_count >= max_attempts:
                email_status = "failed"
                next_attempt_at = None
            else:
                delay = max(1, settings.REMINDER_EMAIL_RETRY_BASE_SECONDS) * (
                    2 ** (claimed.attempt_count - 1)
                )
                email_status = "retrying"
                next_attempt_at = utc_now() + timedelta(seconds=delay)
            result = await session.execute(
                self._claimed_update(claimed).values(
                    email_status=email_status,
                    email_next_attempt_at=next_attempt_at,
                    email_claimed_at=None,
                    email_claim_token=None,
                    email_last_error=(
                        str(error)[:500]
                        if isinstance(error, EmailDeliveryError)
                        else type(error).__name__
                    ),
                )
            )
            if not result.rowcount:
                return
            logger.warning(
                "Reminder email failed reminder_id=%s attempt=%s status=%s",
                claimed.id,
                claimed.attempt_count,
                email_status,
            )

    @staticmethod
    def _claimed_update(claimed: ClaimedReminder):
        return update(Reminder).where(
            Reminder.id == claimed.id,
            Reminder.status == "pending",
            Reminder.email_enabled.is_(True),
            Reminder.email_status == "sending",
            Reminder.email_claim_token == claimed.claim_token,
        )


def build_reminder_email(claimed: ClaimedReminder) -> tuple[str, str]:
    pet_name = PET_NAMES.get(claimed.pet_type, "桌宠")
    title = html.escape(claimed.title)
    username = html.escape(claimed.username)
    timezone_name = settings.PET_REWARD_TIMEZONE
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        timezone = UTC
        timezone_name = "UTC"

    remind_at = claimed.remind_at.replace(tzinfo=UTC).astimezone(timezone)
    time_text = remind_at.strftime("%Y-%m-%d %H:%M")
    safe_subject_title = " ".join(claimed.title.split())[:160]
    subject = f"{pet_name}提醒你：{safe_subject_title}"
    html_content = (
        f"<p>{username}，时间到啦。</p>"
        f"<p><strong>{title}</strong></p>"
        f"<p>{pet_name}会在桌面端继续等你回来处理。</p>"
        f"<p style='color:#64748b'>计划时间：{time_text} ({timezone_name})</p>"
    )
    return subject, html_content


reminder_delivery_service = ReminderDeliveryService()
