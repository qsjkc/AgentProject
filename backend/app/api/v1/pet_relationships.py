from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.models.database import get_db
from app.models.user import User
from app.schemas.pet_relationship import (
    PetRelationshipResponse,
    PetRelationshipRewardRequest,
    PetRelationshipRewardResponse,
    PetType,
)
from app.services.pet_relationships import (
    award_pet_relationship,
    get_or_create_pet_relationship,
    serialize_pet_relationship,
)


router = APIRouter(prefix="/pets", tags=["pet-relationships"])


@router.get("/{pet_type}/relationship", response_model=PetRelationshipResponse)
async def get_pet_relationship(
    pet_type: PetType,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    relationship = await get_or_create_pet_relationship(
        db,
        user_id=current_user.id,
        pet_type=pet_type,
    )
    return serialize_pet_relationship(relationship)


@router.post(
    "/{pet_type}/relationship/rewards",
    response_model=PetRelationshipRewardResponse,
)
async def reward_pet_relationship(
    pet_type: PetType,
    payload: PetRelationshipRewardRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await award_pet_relationship(
        db,
        user_id=current_user.id,
        pet_type=pet_type,
        action=payload.action,
        idempotency_key=payload.idempotency_key,
    )
