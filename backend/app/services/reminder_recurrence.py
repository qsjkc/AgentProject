import asyncio
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import logger
from app.core.time import utc_now
from app.models.database import Reminder, ReminderSeries, async_session_maker


RECURRENCE_WEEKDAYS = {
    "daily": [0, 1, 2, 3, 4, 5, 6],
    "weekdays": [0, 1, 2, 3, 4],
}


def as_local(utc_value: datetime, timezone_name: str) -> datetime:
    aware_utc = (
        utc_value.replace(tzinfo=UTC)
        if utc_value.tzinfo is None
        else utc_value.astimezone(UTC)
    )
    return aware_utc.astimezone(ZoneInfo(timezone_name))


def as_utc_naive(local_value: datetime) -> datetime:
    return local_value.astimezone(UTC).replace(tzinfo=None)


def build_local_occurrence(
    local_date: date,
    *,
    local_hour: int,
    local_minute: int,
    timezone_name: str,
) -> datetime:
    timezone = ZoneInfo(timezone_name)
    candidate = datetime.combine(
        local_date,
        time(local_hour, local_minute),
        tzinfo=timezone,
    )
    round_trip = candidate.astimezone(UTC).astimezone(timezone)
    if (
        round_trip.date() != local_date
        or round_trip.hour != local_hour
        or round_trip.minute != local_minute
    ):
        return round_trip
    return candidate


def calculate_next_occurrence(
    after_utc: datetime,
    *,
    local_hour: int,
    local_minute: int,
    timezone_name: str,
    weekdays: list[int],
) -> datetime:
    local_after = as_local(after_utc, timezone_name)
    candidate_date = local_after.date() + timedelta(days=1)
    allowed_weekdays = set(weekdays)
    for _ in range(8):
        if candidate_date.weekday() in allowed_weekdays:
            candidate_local = build_local_occurrence(
                candidate_date,
                local_hour=local_hour,
                local_minute=local_minute,
                timezone_name=timezone_name,
            )
            return as_utc_naive(candidate_local)
        candidate_date += timedelta(days=1)
    raise ValueError("Recurrence rule has no reachable weekday")


def normalize_first_occurrence(
    remind_at: datetime,
    *,
    recurrence_type: str,
    timezone_name: str,
    now: datetime | None = None,
) -> tuple[datetime, int, int, list[int]]:
    local_value = as_local(remind_at, timezone_name)
    local_hour = local_value.hour
    local_minute = local_value.minute
    weekdays = (
        [local_value.weekday()]
        if recurrence_type == "weekly"
        else RECURRENCE_WEEKDAYS[recurrence_type]
    )
    current = now or utc_now()
    current_utc = (
        current.replace(tzinfo=None)
        if current.tzinfo is None
        else current.astimezone(UTC).replace(tzinfo=None)
    )
    current_local = as_local(current_utc, timezone_name)
    candidate_date = max(local_value.date(), current_local.date())
    candidate_local = build_local_occurrence(
        candidate_date,
        local_hour=local_hour,
        local_minute=local_minute,
        timezone_name=timezone_name,
    )
    candidate = as_utc_naive(candidate_local)
    if candidate <= current_utc:
        candidate_date += timedelta(days=1)
    for _ in range(8):
        if candidate_date.weekday() in weekdays:
            candidate_local = build_local_occurrence(
                candidate_date,
                local_hour=local_hour,
                local_minute=local_minute,
                timezone_name=timezone_name,
            )
            return (
                as_utc_naive(candidate_local),
                local_hour,
                local_minute,
                weekdays,
            )
        candidate_date += timedelta(days=1)
    raise ValueError("Recurrence rule has no reachable first occurrence")


async def create_recurring_reminder(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    title: str,
    source_text: str | None,
    remind_at: datetime,
    recurrence_type: str,
    timezone_name: str,
    email_enabled: bool,
) -> Reminder:
    first_at, local_hour, local_minute, weekdays = normalize_first_occurrence(
        remind_at,
        recurrence_type=recurrence_type,
        timezone_name=timezone_name,
    )
    next_at = calculate_next_occurrence(
        first_at,
        local_hour=local_hour,
        local_minute=local_minute,
        timezone_name=timezone_name,
        weekdays=weekdays,
    )
    series = ReminderSeries(
        user_id=user_id,
        pet_type=pet_type,
        title=title,
        source_text=source_text,
        recurrence_type=recurrence_type,
        timezone=timezone_name,
        local_hour=local_hour,
        local_minute=local_minute,
        weekdays=weekdays,
        status="active",
        email_enabled=email_enabled,
        next_occurrence_at=next_at,
        next_sequence=2,
    )
    db.add(series)
    await db.flush()

    reminder = Reminder(
        user_id=user_id,
        series_id=series.id,
        pet_type=pet_type,
        title=title,
        source_text=source_text,
        remind_at=first_at,
        status="pending",
        recurrence_type=recurrence_type,
        occurrence_sequence=1,
        creation_source="user",
        email_enabled=email_enabled,
        email_status="pending" if email_enabled else "disabled",
    )
    db.add(reminder)
    await db.flush()
    return reminder


class ReminderRecurrenceService:
    def __init__(self) -> None:
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def startup(self) -> None:
        if not settings.REMINDER_RECURRENCE_WORKER_ENABLED:
            logger.info("Reminder recurrence worker disabled by configuration")
            return
        if self._task and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(
            self._run(),
            name="reminder-recurrence-materializer",
        )
        logger.info("Reminder recurrence worker started")

    async def shutdown(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        await self._task
        self._task = None
        logger.info("Reminder recurrence worker stopped")

    async def _run(self) -> None:
        interval = max(1, settings.REMINDER_RECURRENCE_POLL_INTERVAL_SECONDS)
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
                logger.exception("Reminder recurrence materialization cycle failed")

    async def process_due_once(self) -> int:
        if self._stop_event.is_set():
            return 0
        created = 0
        processed_series_ids: set[int] = set()
        for _ in range(max(1, settings.REMINDER_RECURRENCE_BATCH_SIZE)):
            result = await self._materialize_one(processed_series_ids)
            if result is None:
                break
            series_id, created_count = result
            processed_series_ids.add(series_id)
            created += created_count
        return created

    async def _materialize_one(
        self,
        excluded_series_ids: set[int],
    ) -> tuple[int, int] | None:
        now = utc_now()
        horizon = now + timedelta(
            seconds=max(0, settings.REMINDER_RECURRENCE_LOOKAHEAD_SECONDS)
        )
        oldest_allowed = now - timedelta(
            seconds=max(0, settings.REMINDER_RECURRENCE_MISSED_GRACE_SECONDS)
        )

        async with async_session_maker.begin() as session:
            query = (
                select(ReminderSeries)
                .where(
                    ReminderSeries.status == "active",
                    ReminderSeries.next_occurrence_at <= horizon,
                )
                .order_by(
                    ReminderSeries.next_occurrence_at.asc(),
                    ReminderSeries.id.asc(),
                )
                .limit(1)
                .with_for_update(skip_locked=True, of=ReminderSeries)
            )
            if excluded_series_ids:
                query = query.where(ReminderSeries.id.not_in(excluded_series_ids))
            series = (await session.execute(query)).scalar_one_or_none()
            if series is None:
                return None

            created_count = 0
            steps = 0
            max_steps = max(1, settings.REMINDER_RECURRENCE_MAX_CATCHUP_STEPS)
            while series.next_occurrence_at <= horizon and steps < max_steps:
                occurrence_at = series.next_occurrence_at
                occurrence_sequence = series.next_sequence
                try:
                    next_occurrence_at = calculate_next_occurrence(
                        occurrence_at,
                        local_hour=series.local_hour,
                        local_minute=series.local_minute,
                        timezone_name=series.timezone,
                        weekdays=list(series.weekdays),
                    )
                except (ValueError, ZoneInfoNotFoundError):
                    series.status = "paused"
                    logger.exception(
                        "Paused invalid reminder series series_id=%s",
                        series.id,
                    )
                    break
                series.next_occurrence_at = next_occurrence_at
                series.next_sequence += 1
                steps += 1

                if occurrence_at < oldest_allowed:
                    series.skipped_occurrence_count += 1
                    continue

                session.add(
                    Reminder(
                        user_id=series.user_id,
                        series_id=series.id,
                        pet_type=series.pet_type,
                        title=series.title,
                        source_text=series.source_text,
                        remind_at=occurrence_at,
                        status="pending",
                        recurrence_type=series.recurrence_type,
                        occurrence_sequence=occurrence_sequence,
                        creation_source="recurrence",
                        email_enabled=series.email_enabled,
                        email_status="pending" if series.email_enabled else "disabled",
                    )
                )
                series.last_materialized_at = utc_now()
                created_count += 1

            return series.id, created_count


reminder_recurrence_service = ReminderRecurrenceService()
