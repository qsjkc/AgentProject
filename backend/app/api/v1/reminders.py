from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.time import utc_now
from app.models.database import Reminder, get_db
from app.models.user import User
from app.schemas.reminder import (
    PendingReminderSummary,
    PetType,
    ReminderCreate,
    ReminderResponse,
    ReminderStatus,
    ReminderUpdate,
    normalize_reminder_datetime,
)


router = APIRouter(prefix="/reminders", tags=["reminders"])


async def get_owned_reminder(reminder_id: int, current_user: User, db: AsyncSession) -> Reminder:
    result = await db.execute(select(Reminder).where(Reminder.id == reminder_id, Reminder.user_id == current_user.id))
    reminder = result.scalar_one_or_none()
    if reminder is None:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return reminder


@router.post("", response_model=ReminderResponse)
async def create_reminder(
    payload: ReminderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = Reminder(
        user_id=current_user.id,
        pet_type=payload.pet_type,
        title=payload.title,
        source_text=payload.source_text,
        remind_at=payload.remind_at,
        status="pending",
    )
    db.add(reminder)
    await db.commit()
    await db.refresh(reminder)
    return reminder


@router.get("", response_model=List[ReminderResponse])
async def list_reminders(
    pet_type: Optional[PetType] = Query(default=None),
    status: Optional[ReminderStatus] = Query(default=None),
    due_before: Optional[datetime] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Reminder).where(Reminder.user_id == current_user.id)
    if pet_type:
        query = query.where(Reminder.pet_type == pet_type)
    if status:
        query = query.where(Reminder.status == status)
    if due_before:
        query = query.where(Reminder.remind_at <= normalize_reminder_datetime(due_before))
    query = query.order_by(Reminder.remind_at.asc(), Reminder.id.asc())
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/pending-summary", response_model=PendingReminderSummary)
async def pending_summary(
    pet_type: PetType,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(func.count(Reminder.id)).where(
            Reminder.user_id == current_user.id,
            Reminder.pet_type == pet_type,
            Reminder.status == "pending",
        )
    )
    return PendingReminderSummary(pet_type=pet_type, pending_count=result.scalar_one())


@router.patch("/{reminder_id}", response_model=ReminderResponse)
async def update_reminder(
    reminder_id: int,
    payload: ReminderUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = await get_owned_reminder(reminder_id, current_user, db)
    if payload.title is not None:
        reminder.title = payload.title
    if payload.remind_at is not None:
        reminder.remind_at = payload.remind_at
    if payload.status is not None:
        reminder.status = payload.status
        if payload.status in {"completed", "canceled"}:
            reminder.completed_at = utc_now()
    await db.commit()
    await db.refresh(reminder)
    return reminder


@router.post("/{reminder_id}/complete", response_model=ReminderResponse)
async def complete_reminder(
    reminder_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = await get_owned_reminder(reminder_id, current_user, db)
    now = utc_now()
    reminder.status = "completed"
    reminder.triggered_at = now
    reminder.completed_at = now
    await db.commit()
    await db.refresh(reminder)
    return reminder
