from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from math import ceil
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.time import utc_now
from app.models.database import (
    ChatMessage,
    ChatSession,
    PetActivityEvent,
    PetIntimacyEvent,
    PetRelationship,
    PetRelationshipMilestone,
    Reminder,
)
from app.services.pet_outfits import (
    build_pet_outfit_state,
    get_pet_outfit_item,
    get_pet_outfit_catalog,
    merge_unlocked_outfit_ids,
    normalize_equipped_outfits,
)
from app.services.pet_retention import (
    WEEKLY_REVIEW_GENERATED,
    WEEKLY_REVIEW_SEEN,
    WEEKLY_REVIEW_SHOWN,
    record_pet_retention_event,
    record_weekly_review_follow_up,
)


RELATIONSHIP_LEVELS = (
    (1, 0, "new_friend"),
    (2, 100, "getting_familiar"),
    (3, 260, "clingy"),
    (4, 520, "trusted_partner"),
    (5, 900, "deep_bond"),
)
MAX_INTIMACY_XP = RELATIONSHIP_LEVELS[-1][1]
DAILY_XP_CAP = 120
MILESTONE_CLAIM_LEASE_SECONDS = 5 * 60
EXTERNAL_ACTIVITY_ACTIONS = (
    "reminder_created",
    "reminder_completed",
    "meaningful_chat",
)


@dataclass(frozen=True)
class RewardPolicy:
    xp: int
    cooldown_seconds: int
    daily_cap: int


REWARD_POLICIES = {
    "daily_first_wake": RewardPolicy(xp=5, cooldown_seconds=0, daily_cap=5),
    "poke": RewardPolicy(xp=1, cooldown_seconds=60, daily_cap=20),
    "drag_release": RewardPolicy(xp=1, cooldown_seconds=60, daily_cap=10),
    "pat": RewardPolicy(xp=3, cooldown_seconds=5 * 60, daily_cap=30),
    "feed": RewardPolicy(xp=5, cooldown_seconds=30 * 60, daily_cap=20),
    "clean": RewardPolicy(xp=4, cooldown_seconds=30 * 60, daily_cap=16),
    "dress_up": RewardPolicy(xp=3, cooldown_seconds=10 * 60, daily_cap=12),
    "reminder_created": RewardPolicy(xp=4, cooldown_seconds=0, daily_cap=20),
    "reminder_completed": RewardPolicy(xp=10, cooldown_seconds=0, daily_cap=50),
    "meaningful_chat": RewardPolicy(xp=2, cooldown_seconds=5 * 60, daily_cap=20),
}


def get_relationship_level(intimacy_xp: int) -> tuple[int, str]:
    normalized_xp = max(0, int(intimacy_xp))
    level, _, stage = RELATIONSHIP_LEVELS[0]
    for candidate_level, threshold, candidate_stage in RELATIONSHIP_LEVELS:
        if normalized_xp < threshold:
            break
        level = candidate_level
        stage = candidate_stage
    return level, stage


def get_relationship_progress(intimacy_xp: int) -> dict[str, int | float]:
    normalized_xp = max(0, int(intimacy_xp))
    level, _ = get_relationship_level(normalized_xp)
    current_threshold = RELATIONSHIP_LEVELS[level - 1][1]

    if level == RELATIONSHIP_LEVELS[-1][0]:
        return {"current": 0, "required": 0, "percent": 100.0}

    next_threshold = RELATIONSHIP_LEVELS[level][1]
    current = normalized_xp - current_threshold
    required = next_threshold - current_threshold
    percent = round((current / required) * 100, 2)
    return {"current": current, "required": required, "percent": percent}


def get_reward_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    aware_utc = now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)
    local_now = aware_utc.astimezone(ZoneInfo(settings.PET_REWARD_TIMEZONE))
    local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    local_end = local_start + timedelta(days=1)
    return (
        local_start.astimezone(UTC).replace(tzinfo=None),
        local_end.astimezone(UTC).replace(tzinfo=None),
    )


def get_reward_local_date(now: datetime) -> date:
    aware_utc = now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)
    return aware_utc.astimezone(ZoneInfo(settings.PET_REWARD_TIMEZONE)).date()


def get_completed_reward_week_bounds(
    now: datetime,
) -> tuple[date, date, datetime, datetime]:
    aware_utc = now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)
    timezone = ZoneInfo(settings.PET_REWARD_TIMEZONE)
    local_today = aware_utc.astimezone(timezone).date()
    current_week_start = local_today - timedelta(days=local_today.weekday())
    week_start = current_week_start - timedelta(days=7)
    week_end = current_week_start - timedelta(days=1)
    local_start = datetime.combine(week_start, datetime.min.time(), tzinfo=timezone)
    local_end = datetime.combine(current_week_start, datetime.min.time(), tzinfo=timezone)
    return (
        week_start,
        week_end,
        local_start.astimezone(UTC).replace(tzinfo=None),
        local_end.astimezone(UTC).replace(tzinfo=None),
    )


def get_local_event_date(value: datetime) -> date:
    aware_utc = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return aware_utc.astimezone(ZoneInfo(settings.PET_REWARD_TIMEZONE)).date()


async def get_pet_daily_summary(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    now: datetime | None = None,
) -> dict:
    summary_time = now or utc_now()
    day_start, day_end = get_reward_day_bounds(summary_time)

    xp_result = await db.execute(
        select(func.coalesce(func.sum(PetIntimacyEvent.xp_awarded), 0)).where(
            PetIntimacyEvent.user_id == user_id,
            PetIntimacyEvent.pet_type == pet_type,
            PetIntimacyEvent.awarded_at >= day_start,
            PetIntimacyEvent.awarded_at < day_end,
        )
    )
    xp_gained = xp_result.scalar_one()

    activity_event_result = await db.execute(
        select(
            func.count(PetActivityEvent.id),
            func.min(PetActivityEvent.occurred_at),
            func.max(PetActivityEvent.occurred_at),
        ).where(
            PetActivityEvent.user_id == user_id,
            PetActivityEvent.pet_type == pet_type,
            PetActivityEvent.occurred_at >= day_start,
            PetActivityEvent.occurred_at < day_end,
        )
    )
    activity_event_count, event_first_at, event_last_at = activity_event_result.one()

    action_result = await db.execute(
        select(PetActivityEvent.action, func.count(PetActivityEvent.id))
        .where(
            PetActivityEvent.user_id == user_id,
            PetActivityEvent.pet_type == pet_type,
            PetActivityEvent.occurred_at >= day_start,
            PetActivityEvent.occurred_at < day_end,
        )
        .group_by(PetActivityEvent.action)
    )
    action_counts = {
        action: int(count)
        for action, count in action_result.all()
    }

    reminders_created_result = await db.execute(
        select(
            func.count(Reminder.id),
            func.min(Reminder.created_at),
            func.max(Reminder.created_at),
        ).where(
            Reminder.user_id == user_id,
            Reminder.pet_type == pet_type,
            Reminder.creation_source == "user",
            Reminder.created_at >= day_start,
            Reminder.created_at < day_end,
        )
    )
    reminders_completed_result = await db.execute(
        select(
            func.count(Reminder.id),
            func.min(Reminder.completed_at),
            func.max(Reminder.completed_at),
        ).where(
            Reminder.user_id == user_id,
            Reminder.pet_type == pet_type,
            Reminder.status == "completed",
            Reminder.completed_at >= day_start,
            Reminder.completed_at < day_end,
        )
    )
    meaningful_chats_result = await db.execute(
        select(
            func.count(ChatMessage.id),
            func.min(ChatMessage.created_at),
            func.max(ChatMessage.created_at),
        )
        .join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .where(
            ChatSession.user_id == user_id,
            ChatMessage.role == "user",
            ChatMessage.pet_type == pet_type,
            ChatMessage.created_at >= day_start,
            ChatMessage.created_at < day_end,
        )
    )
    reminders_created_count, reminder_created_first_at, reminder_created_last_at = (
        reminders_created_result.one()
    )
    reminders_completed_count, reminder_completed_first_at, reminder_completed_last_at = (
        reminders_completed_result.one()
    )
    meaningful_chat_count, meaningful_chat_first_at, meaningful_chat_last_at = (
        meaningful_chats_result.one()
    )
    external_action_counts = {
        "reminder_created": int(reminders_created_count),
        "reminder_completed": int(reminders_completed_count),
        "meaningful_chat": int(meaningful_chat_count),
    }
    action_counts.update(
        {
            action: count
            for action, count in external_action_counts.items()
            if count > 0
        }
    )
    interaction_count = (
        int(activity_event_count)
        + int(reminders_created_count)
        + int(reminders_completed_count)
        + int(meaningful_chat_count)
    )
    first_candidates = [
        value
        for value in (
            event_first_at,
            reminder_created_first_at,
            reminder_completed_first_at,
            meaningful_chat_first_at,
        )
        if value is not None
    ]
    last_candidates = [
        value
        for value in (
            event_last_at,
            reminder_created_last_at,
            reminder_completed_last_at,
            meaningful_chat_last_at,
        )
        if value is not None
    ]

    return {
        "pet_type": pet_type,
        "local_date": get_reward_local_date(summary_time),
        "timezone": settings.PET_REWARD_TIMEZONE,
        "interaction_count": interaction_count,
        "xp_gained": int(xp_gained),
        "action_counts": action_counts,
        "care_count": sum(action_counts.get(action, 0) for action in ("pat", "feed", "clean")),
        "meaningful_chat_count": int(meaningful_chat_count),
        "reminders_created_count": int(reminders_created_count),
        "reminders_completed_count": int(reminders_completed_count),
        "first_interaction_at": min(first_candidates) if first_candidates else None,
        "last_interaction_at": max(last_candidates) if last_candidates else None,
    }


async def get_pet_weekly_summary(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    now: datetime | None = None,
) -> dict:
    summary_time = now or utc_now()
    week_start, week_end, range_start, range_end = get_completed_reward_week_bounds(
        summary_time
    )
    review_key = f"{week_start.isoformat()}_{week_end.isoformat()}"
    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )

    xp_before_result = await db.execute(
        select(func.coalesce(func.sum(PetIntimacyEvent.xp_awarded), 0)).where(
            PetIntimacyEvent.user_id == user_id,
            PetIntimacyEvent.pet_type == pet_type,
            PetIntimacyEvent.awarded_at < range_start,
        )
    )
    xp_result = await db.execute(
        select(func.coalesce(func.sum(PetIntimacyEvent.xp_awarded), 0)).where(
            PetIntimacyEvent.user_id == user_id,
            PetIntimacyEvent.pet_type == pet_type,
            PetIntimacyEvent.awarded_at >= range_start,
            PetIntimacyEvent.awarded_at < range_end,
        )
    )
    xp_before = int(xp_before_result.scalar_one())
    xp_gained = int(xp_result.scalar_one())

    activity_result = await db.execute(
        select(PetActivityEvent.action, PetActivityEvent.occurred_at).where(
            PetActivityEvent.user_id == user_id,
            PetActivityEvent.pet_type == pet_type,
            PetActivityEvent.occurred_at >= range_start,
            PetActivityEvent.occurred_at < range_end,
        )
    )
    activity_rows = activity_result.all()
    action_counts: dict[str, int] = {}
    activity_timestamps = []
    for action, occurred_at in activity_rows:
        action_counts[action] = action_counts.get(action, 0) + 1
        activity_timestamps.append(occurred_at)

    reminders_created_result = await db.execute(
        select(Reminder.created_at).where(
            Reminder.user_id == user_id,
            Reminder.pet_type == pet_type,
            Reminder.creation_source == "user",
            Reminder.created_at >= range_start,
            Reminder.created_at < range_end,
        )
    )
    reminders_completed_result = await db.execute(
        select(Reminder.completed_at).where(
            Reminder.user_id == user_id,
            Reminder.pet_type == pet_type,
            Reminder.status == "completed",
            Reminder.completed_at >= range_start,
            Reminder.completed_at < range_end,
        )
    )
    meaningful_chats_result = await db.execute(
        select(ChatMessage.created_at)
        .join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .where(
            ChatSession.user_id == user_id,
            ChatMessage.role == "user",
            ChatMessage.pet_type == pet_type,
            ChatMessage.created_at >= range_start,
            ChatMessage.created_at < range_end,
        )
    )
    reminder_created_timestamps = list(reminders_created_result.scalars().all())
    reminder_completed_timestamps = [
        value for value in reminders_completed_result.scalars().all() if value is not None
    ]
    meaningful_chat_timestamps = list(meaningful_chats_result.scalars().all())
    reminders_created_count = len(reminder_created_timestamps)
    reminders_completed_count = len(reminder_completed_timestamps)
    meaningful_chat_count = len(meaningful_chat_timestamps)

    external_action_counts = {
        "reminder_created": reminders_created_count,
        "reminder_completed": reminders_completed_count,
        "meaningful_chat": meaningful_chat_count,
    }
    action_counts.update(
        {
            action: count
            for action, count in external_action_counts.items()
            if count > 0
        }
    )
    all_timestamps = (
        activity_timestamps
        + reminder_created_timestamps
        + reminder_completed_timestamps
        + meaningful_chat_timestamps
    )
    active_days = len({get_local_event_date(value) for value in all_timestamps})
    interaction_count = len(all_timestamps)
    care_count = sum(action_counts.get(action, 0) for action in ("pat", "feed", "clean"))
    level_at_start, _ = get_relationship_level(xp_before)
    level_at_end, relationship_stage_at_end = get_relationship_level(
        min(MAX_INTIMACY_XP, xp_before + xp_gained)
    )
    levels_gained = max(0, level_at_end - level_at_start)
    eligible = bool(
        care_count
        or meaningful_chat_count
        or reminders_created_count
        or reminders_completed_count
        or interaction_count >= 3
        or levels_gained
    )
    was_reviewed = relationship.last_weekly_review_key == review_key

    summary = {
        "pet_type": pet_type,
        "review_key": review_key,
        "week_start": week_start,
        "week_end": week_end,
        "timezone": settings.PET_REWARD_TIMEZONE,
        "eligible": eligible,
        "is_new": eligible and not was_reviewed,
        "reviewed_at": relationship.last_weekly_review_seen_at if was_reviewed else None,
        "active_days": active_days,
        "interaction_count": interaction_count,
        "xp_gained": xp_gained,
        "action_counts": action_counts,
        "care_count": care_count,
        "meaningful_chat_count": meaningful_chat_count,
        "reminders_created_count": reminders_created_count,
        "reminders_completed_count": reminders_completed_count,
        "level_at_start": level_at_start,
        "level_at_end": level_at_end,
        "levels_gained": levels_gained,
        "relationship_stage_at_end": relationship_stage_at_end,
        "first_interaction_at": min(all_timestamps) if all_timestamps else None,
        "last_interaction_at": max(all_timestamps) if all_timestamps else None,
    }
    if eligible:
        await record_pet_retention_event(
            db,
            user_id=user_id,
            pet_type=pet_type,
            event_type=WEEKLY_REVIEW_GENERATED,
            review_key=review_key,
            occurred_at=summary_time,
        )
    return summary


def ensure_current_weekly_summary(summary: dict, review_key: str) -> None:
    if summary["review_key"] != review_key:
        raise ValueError("Weekly review is no longer current")
    if not summary["eligible"]:
        raise ValueError("Weekly review is not available")


async def mark_pet_weekly_summary_shown(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    review_key: str,
    now: datetime | None = None,
) -> dict:
    summary_time = now or utc_now()
    summary = await get_pet_weekly_summary(
        db,
        user_id=user_id,
        pet_type=pet_type,
        now=summary_time,
    )
    ensure_current_weekly_summary(summary, review_key)
    await record_pet_retention_event(
        db,
        user_id=user_id,
        pet_type=pet_type,
        event_type=WEEKLY_REVIEW_SHOWN,
        review_key=review_key,
        occurred_at=summary_time,
    )
    return summary


async def mark_pet_weekly_summary_seen(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    review_key: str,
    now: datetime | None = None,
) -> dict:
    summary_time = now or utc_now()
    summary = await get_pet_weekly_summary(
        db,
        user_id=user_id,
        pet_type=pet_type,
        now=summary_time,
    )
    ensure_current_weekly_summary(summary, review_key)

    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )
    if relationship.last_weekly_review_key != review_key:
        relationship.last_weekly_review_key = review_key
        relationship.last_weekly_review_seen_at = summary_time
        await db.commit()

    reviewed_at = relationship.last_weekly_review_seen_at or summary_time
    await record_pet_retention_event(
        db,
        user_id=user_id,
        pet_type=pet_type,
        event_type=WEEKLY_REVIEW_SEEN,
        review_key=review_key,
        occurred_at=reviewed_at,
    )

    summary["is_new"] = False
    summary["reviewed_at"] = reviewed_at
    return summary


async def get_or_create_pet_relationship(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
) -> PetRelationship:
    result = await db.execute(
        select(PetRelationship).where(
            PetRelationship.user_id == user_id,
            PetRelationship.pet_type == pet_type,
        )
    )
    relationship = result.scalar_one_or_none()
    if relationship is not None:
        unlocked_outfits = merge_unlocked_outfit_ids(
            pet_type,
            relationship.level,
            relationship.unlocked_outfits,
        )
        equipped_outfits = normalize_equipped_outfits(
            pet_type,
            unlocked_outfits,
            relationship.equipped_outfits,
        )
        if (
            unlocked_outfits != (relationship.unlocked_outfits or [])
            or equipped_outfits != (relationship.equipped_outfits or {})
        ):
            relationship.unlocked_outfits = unlocked_outfits
            relationship.equipped_outfits = equipped_outfits
            await db.commit()
            await db.refresh(relationship)
        return relationship

    relationship = PetRelationship(
        user_id=user_id,
        pet_type=pet_type,
        intimacy_xp=0,
        level=1,
        relationship_stage="new_friend",
        current_mood="idle",
        unlocked_outfits=merge_unlocked_outfit_ids(pet_type, 1),
        equipped_outfits={},
    )
    db.add(relationship)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        result = await db.execute(
            select(PetRelationship).where(
                PetRelationship.user_id == user_id,
                PetRelationship.pet_type == pet_type,
            )
        )
        relationship = result.scalar_one_or_none()
        if relationship is None:
            raise
    await db.refresh(relationship)
    return relationship


def serialize_pet_relationship(relationship: PetRelationship) -> dict:
    level, stage = get_relationship_level(relationship.intimacy_xp)
    return {
        "id": relationship.id,
        "user_id": relationship.user_id,
        "pet_type": relationship.pet_type,
        "intimacy_xp": relationship.intimacy_xp,
        "level": level,
        "relationship_stage": stage,
        "current_mood": relationship.current_mood,
        "progress": get_relationship_progress(relationship.intimacy_xp),
        "outfit": build_pet_outfit_state(
            relationship.pet_type,
            level,
            relationship.unlocked_outfits,
            relationship.equipped_outfits,
        ),
        "last_active_at": relationship.last_active_at,
        "last_greeting_at": relationship.last_greeting_at,
        "last_level_up_at": relationship.last_level_up_at,
        "created_at": relationship.created_at,
        "updated_at": relationship.updated_at,
    }


def get_relationship_milestone_outfit_id(
    pet_type: str,
    level: int,
) -> str | None:
    if pet_type != "pig" or level < 2:
        return None
    return next(
        (
            item["id"]
            for item in get_pet_outfit_catalog(pet_type)
            if item["unlock_level"] == level
        ),
        None,
    )


def add_pet_relationship_milestones(
    db: AsyncSession,
    *,
    relationship: PetRelationship,
    previous_level: int,
    new_level: int,
    achieved_at: datetime,
) -> None:
    for level in range(max(2, previous_level + 1), new_level + 1):
        reward_outfit_id = get_relationship_milestone_outfit_id(
            relationship.pet_type,
            level,
        )
        if reward_outfit_id is None:
            continue
        db.add(
            PetRelationshipMilestone(
                relationship_id=relationship.id,
                level=level,
                reward_outfit_id=reward_outfit_id,
                achieved_at=achieved_at,
            )
        )


def serialize_pet_relationship_milestone(
    milestone: PetRelationshipMilestone,
    *,
    pet_type: str,
) -> dict:
    _, relationship_stage = get_relationship_level(
        RELATIONSHIP_LEVELS[milestone.level - 1][1]
    )
    return {
        "id": milestone.id,
        "pet_type": pet_type,
        "level": milestone.level,
        "relationship_stage": relationship_stage,
        "reward_outfit_id": milestone.reward_outfit_id,
        "achieved_at": milestone.achieved_at,
        "claim_token": milestone.claim_token,
        "claim_expires_at": milestone.claim_expires_at,
        "acknowledged_at": milestone.acknowledged_at,
    }


async def get_owned_pet_relationship_milestone(
    db: AsyncSession,
    *,
    milestone_id: int,
    user_id: int,
    pet_type: str,
) -> PetRelationshipMilestone | None:
    result = await db.execute(
        select(PetRelationshipMilestone)
        .join(
            PetRelationship,
            PetRelationship.id == PetRelationshipMilestone.relationship_id,
        )
        .where(
            PetRelationshipMilestone.id == milestone_id,
            PetRelationship.user_id == user_id,
            PetRelationship.pet_type == pet_type,
        )
        .execution_options(populate_existing=True)
    )
    return result.scalar_one_or_none()


async def claim_pet_relationship_milestone(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    claim_token: str,
    now: datetime | None = None,
) -> dict | None:
    claim_time = now or utc_now()
    claim_time = (
        claim_time.astimezone(UTC).replace(tzinfo=None)
        if claim_time.tzinfo
        else claim_time
    )
    claim_expires_at = claim_time + timedelta(
        seconds=MILESTONE_CLAIM_LEASE_SECONDS
    )
    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )
    relationship_id = relationship.id

    existing_result = await db.execute(
        select(PetRelationshipMilestone)
        .where(
            PetRelationshipMilestone.relationship_id == relationship_id,
            PetRelationshipMilestone.claim_token == claim_token,
        )
        .order_by(PetRelationshipMilestone.level.asc())
        .limit(1)
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        if existing.acknowledged_at is not None:
            return serialize_pet_relationship_milestone(
                existing,
                pet_type=pet_type,
            )

        existing_id = existing.id
        await db.rollback()
        renewed = await db.execute(
            update(PetRelationshipMilestone)
            .where(
                PetRelationshipMilestone.id == existing_id,
                PetRelationshipMilestone.relationship_id == relationship_id,
                PetRelationshipMilestone.acknowledged_at.is_(None),
                PetRelationshipMilestone.claim_token == claim_token,
            )
            .values(claim_expires_at=claim_expires_at)
        )
        if renewed.rowcount == 1:
            await db.commit()
            renewed_milestone = await get_owned_pet_relationship_milestone(
                db,
                milestone_id=existing_id,
                user_id=user_id,
                pet_type=pet_type,
            )
            if renewed_milestone is not None:
                return serialize_pet_relationship_milestone(
                    renewed_milestone,
                    pet_type=pet_type,
                )
        else:
            await db.rollback()

        retry_result = await db.execute(
            select(PetRelationshipMilestone).where(
                PetRelationshipMilestone.relationship_id == relationship_id,
                PetRelationshipMilestone.claim_token == claim_token,
            )
        )
        retry_milestone = retry_result.scalar_one_or_none()
        if retry_milestone is not None:
            return serialize_pet_relationship_milestone(
                retry_milestone,
                pet_type=pet_type,
            )
        return None

    pending_result = await db.execute(
        select(PetRelationshipMilestone)
        .where(
            PetRelationshipMilestone.relationship_id == relationship_id,
            PetRelationshipMilestone.acknowledged_at.is_(None),
        )
        .order_by(PetRelationshipMilestone.level.asc())
        .limit(1)
    )
    pending = pending_result.scalar_one_or_none()
    if pending is None:
        return None
    if (
        pending.claim_token is not None
        and pending.claim_expires_at is not None
        and pending.claim_expires_at > claim_time
    ):
        return None

    pending_id = pending.id
    await db.rollback()
    try:
        claimed = await db.execute(
            update(PetRelationshipMilestone)
            .where(
                PetRelationshipMilestone.id == pending_id,
                PetRelationshipMilestone.relationship_id == relationship_id,
                PetRelationshipMilestone.acknowledged_at.is_(None),
                or_(
                    PetRelationshipMilestone.claim_token.is_(None),
                    PetRelationshipMilestone.claim_expires_at.is_(None),
                    PetRelationshipMilestone.claim_expires_at <= claim_time,
                ),
            )
            .values(
                claim_token=claim_token,
                claim_expires_at=claim_expires_at,
            )
        )
        if claimed.rowcount != 1:
            await db.rollback()
            retry_result = await db.execute(
                select(PetRelationshipMilestone).where(
                    PetRelationshipMilestone.relationship_id == relationship_id,
                    PetRelationshipMilestone.claim_token == claim_token,
                )
            )
            retry_milestone = retry_result.scalar_one_or_none()
            if retry_milestone is None:
                return None
            return serialize_pet_relationship_milestone(
                retry_milestone,
                pet_type=pet_type,
            )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        retry_result = await db.execute(
            select(PetRelationshipMilestone).where(
                PetRelationshipMilestone.relationship_id == relationship_id,
                PetRelationshipMilestone.claim_token == claim_token,
            )
        )
        retry_milestone = retry_result.scalar_one_or_none()
        if retry_milestone is None:
            raise
        return serialize_pet_relationship_milestone(
            retry_milestone,
            pet_type=pet_type,
        )

    claimed_milestone = await get_owned_pet_relationship_milestone(
        db,
        milestone_id=pending_id,
        user_id=user_id,
        pet_type=pet_type,
    )
    if claimed_milestone is None:
        return None
    return serialize_pet_relationship_milestone(
        claimed_milestone,
        pet_type=pet_type,
    )


async def acknowledge_pet_relationship_milestone(
    db: AsyncSession,
    *,
    milestone_id: int,
    user_id: int,
    pet_type: str,
    claim_token: str,
    now: datetime | None = None,
) -> dict:
    acknowledged_at = now or utc_now()
    acknowledged_at = (
        acknowledged_at.astimezone(UTC).replace(tzinfo=None)
        if acknowledged_at.tzinfo
        else acknowledged_at
    )
    milestone = await get_owned_pet_relationship_milestone(
        db,
        milestone_id=milestone_id,
        user_id=user_id,
        pet_type=pet_type,
    )
    if milestone is None:
        raise LookupError("milestone_not_found")
    if milestone.claim_token != claim_token:
        raise PermissionError("milestone_claim_invalid_or_expired")
    if milestone.acknowledged_at is not None:
        return serialize_pet_relationship_milestone(
            milestone,
            pet_type=pet_type,
        )

    await db.rollback()
    acknowledged = await db.execute(
        update(PetRelationshipMilestone)
        .where(
            PetRelationshipMilestone.id == milestone_id,
            PetRelationshipMilestone.acknowledged_at.is_(None),
            PetRelationshipMilestone.claim_token == claim_token,
        )
        .values(
            acknowledged_at=acknowledged_at,
            claim_expires_at=None,
        )
    )
    if acknowledged.rowcount == 1:
        await db.commit()
    else:
        await db.rollback()

    receipt = await get_owned_pet_relationship_milestone(
        db,
        milestone_id=milestone_id,
        user_id=user_id,
        pet_type=pet_type,
    )
    if receipt is None:
        raise LookupError("milestone_not_found")
    if receipt.claim_token != claim_token or receipt.acknowledged_at is None:
        raise PermissionError("milestone_claim_invalid_or_expired")
    return serialize_pet_relationship_milestone(
        receipt,
        pet_type=pet_type,
    )


async def get_daily_reward_totals(
    db: AsyncSession,
    *,
    relationship_id: int,
    action: str,
    day_start: datetime,
    day_end: datetime,
) -> tuple[int, int]:
    daily_result = await db.execute(
        select(func.coalesce(func.sum(PetIntimacyEvent.xp_awarded), 0)).where(
            PetIntimacyEvent.relationship_id == relationship_id,
            PetIntimacyEvent.awarded_at >= day_start,
            PetIntimacyEvent.awarded_at < day_end,
        )
    )
    action_result = await db.execute(
        select(func.coalesce(func.sum(PetIntimacyEvent.xp_awarded), 0)).where(
            PetIntimacyEvent.relationship_id == relationship_id,
            PetIntimacyEvent.action == action,
            PetIntimacyEvent.awarded_at >= day_start,
            PetIntimacyEvent.awarded_at < day_end,
        )
    )
    return int(daily_result.scalar_one()), int(action_result.scalar_one())


async def get_latest_action_event(
    db: AsyncSession,
    *,
    relationship_id: int,
    action: str,
) -> PetIntimacyEvent | None:
    result = await db.execute(
        select(PetIntimacyEvent)
        .where(
            PetIntimacyEvent.relationship_id == relationship_id,
            PetIntimacyEvent.action == action,
        )
        .order_by(PetIntimacyEvent.awarded_at.desc(), PetIntimacyEvent.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def get_activity_daily_limit(policy: RewardPolicy) -> int:
    return max(1, ceil(policy.daily_cap / policy.xp))


async def get_daily_activity_count(
    db: AsyncSession,
    *,
    relationship_id: int,
    action: str,
    day_start: datetime,
    day_end: datetime,
) -> int:
    result = await db.execute(
        select(func.count(PetActivityEvent.id)).where(
            PetActivityEvent.relationship_id == relationship_id,
            PetActivityEvent.action == action,
            PetActivityEvent.occurred_at >= day_start,
            PetActivityEvent.occurred_at < day_end,
        )
    )
    return int(result.scalar_one())


async def get_latest_activity_event(
    db: AsyncSession,
    *,
    relationship_id: int,
    action: str,
) -> PetActivityEvent | None:
    result = await db.execute(
        select(PetActivityEvent)
        .where(
            PetActivityEvent.relationship_id == relationship_id,
            PetActivityEvent.action == action,
        )
        .order_by(PetActivityEvent.occurred_at.desc(), PetActivityEvent.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def has_duplicate_reward_request(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> bool:
    activity_result = await db.execute(
        select(PetActivityEvent.id).where(
            PetActivityEvent.user_id == user_id,
            PetActivityEvent.idempotency_key == idempotency_key,
        )
    )
    if activity_result.scalar_one_or_none() is not None:
        return True

    reward_result = await db.execute(
        select(PetIntimacyEvent.id).where(
            PetIntimacyEvent.user_id == user_id,
            PetIntimacyEvent.idempotency_key == idempotency_key,
        )
    )
    return reward_result.scalar_one_or_none() is not None


def build_reward_response(
    relationship: PetRelationship,
    *,
    action: str,
    policy: RewardPolicy,
    awarded_xp: int,
    reason: str,
    daily_awarded_xp: int,
    action_daily_awarded_xp: int,
    cooldown_remaining_seconds: int = 0,
    level_up: bool = False,
) -> dict:
    return {
        "action": action,
        "requested_xp": policy.xp,
        "awarded_xp": awarded_xp,
        "reason": reason,
        "cooldown_remaining_seconds": cooldown_remaining_seconds,
        "action_daily_awarded_xp": action_daily_awarded_xp,
        "daily_awarded_xp": daily_awarded_xp,
        "level_up": level_up,
        "relationship": serialize_pet_relationship(relationship),
    }


async def award_pet_relationship(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    action: str,
    idempotency_key: str,
    now: datetime | None = None,
) -> dict:
    policy = REWARD_POLICIES[action]
    award_time = now or utc_now()
    award_time = award_time.astimezone(UTC).replace(tzinfo=None) if award_time.tzinfo else award_time

    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )
    locked_result = await db.execute(
        select(PetRelationship)
        .where(PetRelationship.id == relationship.id)
        .with_for_update()
    )
    relationship = locked_result.scalar_one()

    duplicate = await has_duplicate_reward_request(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
    )
    day_start, day_end = get_reward_day_bounds(award_time)
    daily_total, action_total = await get_daily_reward_totals(
        db,
        relationship_id=relationship.id,
        action=action,
        day_start=day_start,
        day_end=day_end,
    )

    if duplicate:
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="duplicate",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

    tracks_activity = action not in EXTERNAL_ACTIVITY_ACTIONS
    if tracks_activity:
        latest_event = await get_latest_activity_event(
            db,
            relationship_id=relationship.id,
            action=action,
        )
        latest_event_at = latest_event.occurred_at if latest_event is not None else None
    else:
        latest_event = await get_latest_action_event(
            db,
            relationship_id=relationship.id,
            action=action,
        )
        latest_event_at = latest_event.awarded_at if latest_event is not None else None

    if latest_event_at is not None and policy.cooldown_seconds:
        elapsed_seconds = (award_time - latest_event_at).total_seconds()
        if elapsed_seconds < policy.cooldown_seconds:
            await record_weekly_review_follow_up(
                db,
                user_id=user_id,
                pet_type=pet_type,
                action=action,
                review_key=relationship.last_weekly_review_key,
                review_seen_at=relationship.last_weekly_review_seen_at,
                occurred_at=award_time,
            )
            return build_reward_response(
                relationship,
                action=action,
                policy=policy,
                awarded_xp=0,
                reason="cooldown",
                cooldown_remaining_seconds=ceil(policy.cooldown_seconds - elapsed_seconds),
                daily_awarded_xp=daily_total,
                action_daily_awarded_xp=action_total,
            )

    activity_limit_reached = False
    state_changed = False
    if tracks_activity:
        activity_count = await get_daily_activity_count(
            db,
            relationship_id=relationship.id,
            action=action,
            day_start=day_start,
            day_end=day_end,
        )
        activity_limit_reached = activity_count >= get_activity_daily_limit(policy)
        if not activity_limit_reached:
            db.add(
                PetActivityEvent(
                    user_id=user_id,
                    relationship_id=relationship.id,
                    pet_type=pet_type,
                    action=action,
                    idempotency_key=idempotency_key,
                    occurred_at=award_time,
                )
            )
            relationship.last_active_at = award_time
            state_changed = True

    action_remaining = policy.daily_cap - action_total
    daily_remaining = DAILY_XP_CAP - daily_total
    awarded_xp = 0
    level_up = False
    if relationship.intimacy_xp >= MAX_INTIMACY_XP:
        reason = "max_level"
    elif activity_limit_reached:
        reason = "action_daily_cap"
    elif action_remaining <= 0:
        reason = "action_daily_cap"
    elif daily_remaining <= 0:
        reason = "daily_cap"
    else:
        awarded_xp = min(
            policy.xp,
            action_remaining,
            daily_remaining,
            MAX_INTIMACY_XP - relationship.intimacy_xp,
        )
        previous_level, _ = get_relationship_level(relationship.intimacy_xp)
        relationship.intimacy_xp += awarded_xp
        relationship.level, relationship.relationship_stage = get_relationship_level(
            relationship.intimacy_xp
        )
        relationship.unlocked_outfits = merge_unlocked_outfit_ids(
            pet_type,
            relationship.level,
            relationship.unlocked_outfits,
        )
        relationship.last_active_at = award_time
        level_up = relationship.level > previous_level
        if level_up:
            relationship.last_level_up_at = award_time
            add_pet_relationship_milestones(
                db,
                relationship=relationship,
                previous_level=previous_level,
                new_level=relationship.level,
                achieved_at=award_time,
            )

        db.add(
            PetIntimacyEvent(
                user_id=user_id,
                relationship_id=relationship.id,
                pet_type=pet_type,
                action=action,
                xp_awarded=awarded_xp,
                idempotency_key=idempotency_key,
                awarded_at=award_time,
            )
        )
        state_changed = True
        reason = "awarded"

    if not state_changed:
        await record_weekly_review_follow_up(
            db,
            user_id=user_id,
            pet_type=pet_type,
            action=action,
            review_key=relationship.last_weekly_review_key,
            review_seen_at=relationship.last_weekly_review_seen_at,
            occurred_at=award_time,
        )
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason=reason,
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if not await has_duplicate_reward_request(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
        ):
            raise
        relationship = await get_or_create_pet_relationship(
            db,
            user_id=user_id,
            pet_type=pet_type,
        )
        daily_total, action_total = await get_daily_reward_totals(
            db,
            relationship_id=relationship.id,
            action=action,
            day_start=day_start,
            day_end=day_end,
        )
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="duplicate",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )
    await db.refresh(relationship)

    await record_weekly_review_follow_up(
        db,
        user_id=user_id,
        pet_type=pet_type,
        action=action,
        review_key=relationship.last_weekly_review_key,
        review_seen_at=relationship.last_weekly_review_seen_at,
        occurred_at=award_time,
    )

    return build_reward_response(
        relationship,
        action=action,
        policy=policy,
        awarded_xp=awarded_xp,
        reason=reason,
        daily_awarded_xp=daily_total + awarded_xp,
        action_daily_awarded_xp=action_total + awarded_xp,
        level_up=level_up,
    )


async def update_pet_outfit(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str,
    slot: str,
    item_id: str | None,
) -> dict:
    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )
    unlocked_outfits = merge_unlocked_outfit_ids(
        pet_type,
        relationship.level,
        relationship.unlocked_outfits,
    )
    equipped_outfits = normalize_equipped_outfits(
        pet_type,
        unlocked_outfits,
        relationship.equipped_outfits,
    )

    if item_id is None:
        equipped_outfits.pop(slot, None)
    else:
        item = get_pet_outfit_item(pet_type, item_id)
        if item is None:
            raise ValueError("unknown_outfit")
        if item["slot"] != slot:
            raise ValueError("outfit_slot_mismatch")
        if item_id not in unlocked_outfits:
            raise PermissionError("outfit_locked")
        equipped_outfits[slot] = item_id

    relationship.unlocked_outfits = unlocked_outfits
    relationship.equipped_outfits = equipped_outfits
    relationship.last_active_at = utc_now().replace(tzinfo=None)
    await db.commit()
    await db.refresh(relationship)
    return serialize_pet_relationship(relationship)
