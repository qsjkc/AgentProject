from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.models.database import get_db
from app.models.user import User
from app.schemas.pet_relationship import (
    PetDailySummaryResponse,
    PetRelationshipMilestoneAckRequest,
    PetRelationshipMilestoneClaimRequest,
    PetRelationshipMilestoneResponse,
    PetRelationshipResponse,
    PetOutfitUpdateRequest,
    PetRelationshipRewardRequest,
    PetRelationshipRewardResponse,
    PetType,
    PetWeeklySummaryResponse,
    PetWeeklySummarySeenRequest,
)
from app.services.pet_relationships import (
    acknowledge_pet_relationship_milestone,
    award_pet_relationship,
    claim_pet_relationship_milestone,
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
    "/{pet_type}/relationship/milestones/claim",
    response_model=PetRelationshipMilestoneResponse,
    responses={status.HTTP_204_NO_CONTENT: {"description": "No claimable milestone"}},
)
async def claim_relationship_milestone(
    pet_type: PetType,
    payload: PetRelationshipMilestoneClaimRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    milestone = await claim_pet_relationship_milestone(
        db,
        user_id=current_user.id,
        pet_type=pet_type,
        claim_token=str(payload.claim_token),
    )
    if milestone is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return milestone


@router.post(
    "/{pet_type}/relationship/milestones/{milestone_id}/ack",
    response_model=PetRelationshipMilestoneResponse,
)
async def acknowledge_relationship_milestone(
    pet_type: PetType,
    milestone_id: int,
    payload: PetRelationshipMilestoneAckRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await acknowledge_pet_relationship_milestone(
            db,
            milestone_id=milestone_id,
            user_id=current_user.id,
            pet_type=pet_type,
            claim_token=str(payload.claim_token),
        )
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except PermissionError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error


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
