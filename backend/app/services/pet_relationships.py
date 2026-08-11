from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from math import ceil
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
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
    Reminder,
)
from app.services.pet_outfits import (
    build_pet_outfit_state,
    get_pet_outfit_item,
    merge_unlocked_outfit_ids,
    normalize_equipped_outfits,
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

    return {
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
    if summary["review_key"] != review_key:
        raise ValueError("Weekly review is no longer current")
    if not summary["eligible"]:
        raise ValueError("Weekly review is not available")

    relationship = await get_or_create_pet_relationship(
        db,
        user_id=user_id,
        pet_type=pet_type,
    )
    if relationship.last_weekly_review_key != review_key:
        relationship.last_weekly_review_key = review_key
        relationship.last_weekly_review_seen_at = summary_time
        await db.commit()

    summary["is_new"] = False
    summary["reviewed_at"] = relationship.last_weekly_review_seen_at
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
        previous_level = relationship.level
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
