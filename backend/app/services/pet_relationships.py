from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import ceil
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.time import utc_now
from app.models.database import PetIntimacyEvent, PetRelationship
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

    duplicate_result = await db.execute(
        select(PetIntimacyEvent).where(
            PetIntimacyEvent.user_id == user_id,
            PetIntimacyEvent.idempotency_key == idempotency_key,
        )
    )
    duplicate = duplicate_result.scalar_one_or_none()
    day_start, day_end = get_reward_day_bounds(award_time)
    daily_total, action_total = await get_daily_reward_totals(
        db,
        relationship_id=relationship.id,
        action=action,
        day_start=day_start,
        day_end=day_end,
    )

    if duplicate is not None:
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="duplicate",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

    if relationship.intimacy_xp >= MAX_INTIMACY_XP:
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="max_level",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

    latest_event = await get_latest_action_event(
        db,
        relationship_id=relationship.id,
        action=action,
    )
    if latest_event is not None and policy.cooldown_seconds:
        elapsed_seconds = (award_time - latest_event.awarded_at).total_seconds()
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

    action_remaining = policy.daily_cap - action_total
    if action_remaining <= 0:
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="action_daily_cap",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

    daily_remaining = DAILY_XP_CAP - daily_total
    if daily_remaining <= 0:
        return build_reward_response(
            relationship,
            action=action,
            policy=policy,
            awarded_xp=0,
            reason="daily_cap",
            daily_awarded_xp=daily_total,
            action_daily_awarded_xp=action_total,
        )

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
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        duplicate_result = await db.execute(
            select(PetIntimacyEvent).where(
                PetIntimacyEvent.user_id == user_id,
                PetIntimacyEvent.idempotency_key == idempotency_key,
            )
        )
        if duplicate_result.scalar_one_or_none() is None:
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
        reason="awarded",
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
