from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.models.database import UserPreference, get_db
from app.models.user import User
from app.schemas.user import UserPreferenceResponse, UserPreferenceUpdate

router = APIRouter(prefix="/users", tags=["users"])


async def ensure_preferences(current_user: User, db: AsyncSession) -> UserPreference:
    result = await db.execute(select(UserPreference).where(UserPreference.user_id == current_user.id))
    preferences = result.scalar_one_or_none()
    if not preferences:
        preferences = UserPreference(user_id=current_user.id)
        db.add(preferences)
        await db.commit()
        await db.refresh(preferences)
    return preferences


@router.get("/me/preferences", response_model=UserPreferenceResponse)
async def get_preferences(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserPreferenceResponse:
    return await ensure_preferences(current_user, db)


@router.put("/me/preferences", response_model=UserPreferenceResponse)
async def update_preferences(
    payload: UserPreferenceUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserPreferenceResponse:
    preferences = await ensure_preferences(current_user, db)
    preferences.pet_type = payload.pet_type
    preferences.quick_chat_enabled = payload.quick_chat_enabled
    preferences.bubble_frequency = payload.bubble_frequency
    await db.commit()
    await db.refresh(preferences)
    return preferences
