from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select
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
WEEKLY_REVIEW_FOLLOW_UP_EVENT_TYPES = frozenset(
    WEEKLY_REVIEW_FOLLOW_UP_EVENTS.values()
)
WEEKLY_REVIEW_SHOWN_OR_LATER = frozenset(
    {
        WEEKLY_REVIEW_SHOWN,
        WEEKLY_REVIEW_SEEN,
        *WEEKLY_REVIEW_FOLLOW_UP_EVENT_TYPES,
    }
)
WEEKLY_REVIEW_SEEN_OR_LATER = frozenset(
    {
        WEEKLY_REVIEW_SEEN,
        *WEEKLY_REVIEW_FOLLOW_UP_EVENT_TYPES,
    }
)


def normalize_event_time(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


def conversion_rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 4)


async def get_weekly_review_funnel(
    db: AsyncSession,
    *,
    pet_type: str,
    limit: int,
) -> list[dict]:
    review_key_result = await db.execute(
        select(PetRetentionEvent.review_key)
        .where(PetRetentionEvent.pet_type == pet_type)
        .distinct()
        .order_by(PetRetentionEvent.review_key.desc())
        .limit(limit)
    )
    review_keys = list(review_key_result.scalars().all())
    if not review_keys:
        return []

    def distinct_users_for(event_types: frozenset[str]):
        return func.count(
            func.distinct(
                case(
                    (
                        PetRetentionEvent.event_type.in_(tuple(event_types)),
                        PetRetentionEvent.user_id,
                    ),
                    else_=None,
                )
            )
        )

    aggregate_result = await db.execute(
        select(
            PetRetentionEvent.review_key,
            func.count(func.distinct(PetRetentionEvent.user_id)).label(
                "generated_users"
            ),
            distinct_users_for(WEEKLY_REVIEW_SHOWN_OR_LATER).label("shown_users"),
            distinct_users_for(WEEKLY_REVIEW_SEEN_OR_LATER).label("seen_users"),
            distinct_users_for(WEEKLY_REVIEW_FOLLOW_UP_EVENT_TYPES).label(
                "follow_up_users"
            ),
            distinct_users_for(
                frozenset({"weekly_review_follow_up_care"})
            ).label("follow_up_care_users"),
            distinct_users_for(
                frozenset({"weekly_review_follow_up_chat"})
            ).label("follow_up_chat_users"),
            distinct_users_for(
                frozenset({"weekly_review_follow_up_reminder"})
            ).label("follow_up_reminder_users"),
        )
        .where(
            PetRetentionEvent.pet_type == pet_type,
            PetRetentionEvent.review_key.in_(review_keys),
        )
        .group_by(PetRetentionEvent.review_key)
    )
    aggregates = {
        row["review_key"]: row
        for row in aggregate_result.mappings().all()
    }

    items = []
    for review_key in review_keys:
        row = aggregates[review_key]
        generated_users = int(row["generated_users"])
        shown_users = int(row["shown_users"])
        seen_users = int(row["seen_users"])
        follow_up_users = int(row["follow_up_users"])
        items.append(
            {
                "review_key": review_key,
                "generated_users": generated_users,
                "shown_users": shown_users,
                "seen_users": seen_users,
                "follow_up_users": follow_up_users,
                "follow_up_care_users": int(row["follow_up_care_users"]),
                "follow_up_chat_users": int(row["follow_up_chat_users"]),
                "follow_up_reminder_users": int(row["follow_up_reminder_users"]),
                "shown_from_generated_rate": conversion_rate(
                    shown_users,
                    generated_users,
                ),
                "seen_from_shown_rate": conversion_rate(seen_users, shown_users),
                "follow_up_from_seen_rate": conversion_rate(
                    follow_up_users,
                    seen_users,
                ),
            }
        )
    return items


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
