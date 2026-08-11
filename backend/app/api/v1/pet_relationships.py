from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.models.database import get_db
from app.models.user import User
from app.schemas.pet_relationship import (
    PetDailySummaryResponse,
    PetRelationshipResponse,
    PetOutfitUpdateRequest,
    PetRelationshipRewardRequest,
    PetRelationshipRewardResponse,
    PetType,
    PetWeeklySummaryResponse,
    PetWeeklySummarySeenRequest,
)
from app.services.pet_relationships import (
    award_pet_relationship,
    get_or_create_pet_relationship,
    get_pet_daily_summary,
    get_pet_weekly_summary,
    mark_pet_weekly_summary_shown,
    mark_pet_weekly_summary_seen,
    serialize_pet_relationship,
    update_pet_outfit,
)


router = APIRouter(prefix="/pets", tags=["pet-relationships"])


@router.get("/{pet_type}/daily-summary", response_model=PetDailySummaryResponse)
async def get_daily_summary(
    pet_type: PetType,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_pet_daily_summary(
        db,
        user_id=current_user.id,
        pet_type=pet_type,
    )


@router.get("/{pet_type}/weekly-summary", response_model=PetWeeklySummaryResponse)
async def get_weekly_summary(
    pet_type: PetType,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_pet_weekly_summary(
        db,
        user_id=current_user.id,
        pet_type=pet_type,
    )


@router.post(
    "/{pet_type}/weekly-summary/shown",
    response_model=PetWeeklySummaryResponse,
)
async def mark_weekly_summary_shown(
    pet_type: PetType,
    payload: PetWeeklySummarySeenRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await mark_pet_weekly_summary_shown(
            db,
            user_id=current_user.id,
            pet_type=pet_type,
            review_key=payload.review_key,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error


@router.post(
    "/{pet_type}/weekly-summary/seen",
    response_model=PetWeeklySummaryResponse,
)
async def mark_weekly_summary_seen(
    pet_type: PetType,
    payload: PetWeeklySummarySeenRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await mark_pet_weekly_summary_seen(
            db,
            user_id=current_user.id,
            pet_type=pet_type,
            review_key=payload.review_key,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error


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


@router.put(
    "/{pet_type}/relationship/outfit",
    response_model=PetRelationshipResponse,
)
async def set_pet_outfit(
    pet_type: PetType,
    payload: PetOutfitUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await update_pet_outfit(
            db,
            user_id=current_user.id,
            pet_type=pet_type,
            slot=payload.slot,
            item_id=payload.item_id,
        )
    except PermissionError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
