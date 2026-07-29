from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import PetRelationship


RELATIONSHIP_LEVELS = (
    (1, 0, "new_friend"),
    (2, 100, "getting_familiar"),
    (3, 260, "clingy"),
    (4, 520, "trusted_partner"),
    (5, 900, "deep_bond"),
)


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
        return relationship

    relationship = PetRelationship(
        user_id=user_id,
        pet_type=pet_type,
        intimacy_xp=0,
        level=1,
        relationship_stage="new_friend",
        current_mood="idle",
    )
    db.add(relationship)
    await db.commit()
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
        "last_active_at": relationship.last_active_at,
        "last_greeting_at": relationship.last_greeting_at,
        "last_level_up_at": relationship.last_level_up_at,
        "created_at": relationship.created_at,
        "updated_at": relationship.updated_at,
    }
