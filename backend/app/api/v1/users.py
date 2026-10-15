from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.models.database import UserPreference, get_db
from app.models.user import User
from app.schemas.user import UserPreferenceResponse, UserPreferenceUpdate
from app.services.user_preferences import get_or_create_preferences

router = APIRouter(prefix="/users", tags=["users"])


async def ensure_preferences(current_user: User, db: AsyncSession) -> UserPreference:
    preferences, write_attempted = await get_or_create_preferences(current_user.id, db)
    if write_attempted:
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
    # Schema defaults describe a new account, not edits to an existing choice.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(preferences, field, value)
    await db.commit()
    await db.refresh(preferences)
    return preferences
