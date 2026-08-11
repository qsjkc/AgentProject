from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.core.time import utc_now
from app.models.database import PetRetentionEvent


WEEKLY_REVIEW_GENERATED = "weekly_review_generated"
WEEKLY_REVIEW_SHOWN = "weekly_review_shown"
WEEKLY_REVIEW_SEEN = "weekly_review_seen"
WEEKLY_REVIEW_FOLLOW_UP_EVENTS = {
    "pat": "weekly_review_follow_up_care",
    "feed": "weekly_review_follow_up_care",
    "clean": "weekly_review_follow_up_care",
    "meaningful_chat": "weekly_review_follow_up_chat",
    "reminder_created": "weekly_review_follow_up_reminder",
    "reminder_completed": "weekly_review_follow_up_reminder",
}
PET_RETENTION_EVENT_TYPES = frozenset(
    {
        WEEKLY_REVIEW_GENERATED,
        WEEKLY_REVIEW_SHOWN,
        WEEKLY_REVIEW_SEEN,
        *WEEKLY_REVIEW_FOLLOW_UP_EVENTS.values(),
    }
)
WEEKLY_REVIEW_FOLLOW_UP_WINDOW = timedelta(days=7)


def normalize_event_time(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


async def record_pet_retention_event(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    event_type: str,
    review_key: str,
    occurred_at: datetime | None = None,
) -> bool:
    if event_type not in PET_RETENTION_EVENT_TYPES:
        raise ValueError("unknown_retention_event")

    event_time = normalize_event_time(occurred_at or utc_now())
    try:
        existing_result = await db.execute(
            select(PetRetentionEvent.id).where(
                PetRetentionEvent.user_id == user_id,
                PetRetentionEvent.pet_type == pet_type,
                PetRetentionEvent.event_type == event_type,
                PetRetentionEvent.review_key == review_key,
            )
        )
        if existing_result.scalar_one_or_none() is not None:
            return False

        db.add(
            PetRetentionEvent(
                user_id=user_id,
                pet_type=pet_type,
                event_type=event_type,
                review_key=review_key,
                occurred_at=event_time,
            )
        )
        await db.commit()
        return True
    except IntegrityError:
        await db.rollback()
        return False
    except SQLAlchemyError:
        await db.rollback()
        logger.exception(
            "Failed to record pet retention event user_id=%s pet_type=%s event_type=%s review_key=%s",
            user_id,
            pet_type,
            event_type,
            review_key,
        )
        return False


async def record_weekly_review_follow_up(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    action: str,
    review_key: str | None,
    review_seen_at: datetime | None,
    occurred_at: datetime | None = None,
) -> bool:
    event_type = WEEKLY_REVIEW_FOLLOW_UP_EVENTS.get(action)
    if event_type is None or not review_key or review_seen_at is None:
        return False

    event_time = normalize_event_time(occurred_at or utc_now())
    seen_time = normalize_event_time(review_seen_at)
    if event_time < seen_time or event_time > seen_time + WEEKLY_REVIEW_FOLLOW_UP_WINDOW:
        return False

    return await record_pet_retention_event(
        db,
        user_id=user_id,
        pet_type=pet_type,
        event_type=event_type,
        review_key=review_key,
        occurred_at=event_time,
    )
