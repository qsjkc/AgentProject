from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.core.logging import logger
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
from app.services.pet_relationships import award_pet_relationship
from app.services.reminder_recurrence import create_recurring_reminder
from app.services.reminder_state import reset_email_delivery, stop_email_delivery


router = APIRouter(prefix="/reminders", tags=["reminders"])


async def reward_reminder_action(
    db: AsyncSession,
    *,
    current_user: User,
    reminder: Reminder,
    action: str,
) -> None:
    try:
        await award_pet_relationship(
            db,
            user_id=current_user.id,
            pet_type=reminder.pet_type,
            action=action,
            idempotency_key=f"reminder:{reminder.id}:{action}",
        )
    except Exception:
        logger.exception(
            "Failed to award reminder intimacy user_id=%s reminder_id=%s action=%s",
            current_user.id,
            reminder.id,
            action,
        )


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
    if payload.recurrence_type == "once":
        reminder = Reminder(
            user_id=current_user.id,
            pet_type=payload.pet_type,
            title=payload.title,
            source_text=payload.source_text,
            remind_at=payload.remind_at,
            status="pending",
            recurrence_type="once",
            creation_source="user",
            email_enabled=payload.email_enabled,
            email_status="pending" if payload.email_enabled else "disabled",
        )
        db.add(reminder)
    else:
        reminder = await create_recurring_reminder(
            db,
            user_id=current_user.id,
            pet_type=payload.pet_type,
            title=payload.title,
            source_text=payload.source_text,
            remind_at=payload.remind_at,
            recurrence_type=payload.recurrence_type,
            timezone_name=payload.recurrence_timezone or settings.PET_REWARD_TIMEZONE,
            email_enabled=payload.email_enabled,
        )
    await db.commit()
    await db.refresh(reminder)
    await reward_reminder_action(
        db,
        current_user=current_user,
        reminder=reminder,
        action="reminder_created",
    )
    return reminder


@router.get("", response_model=List[ReminderResponse])
async def list_reminders(
    pet_type: Optional[PetType] = Query(default=None),
    status: Optional[ReminderStatus] = Query(default=None),
    due_before: Optional[datetime] = Query(default=None),
    triggered: Optional[bool] = Query(default=None),
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
    if triggered is not None:
        query = query.where(
            Reminder.triggered_at.is_not(None)
            if triggered
            else Reminder.triggered_at.is_(None)
        )
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
    delivery_changed = False
    remind_at_changed = False
    reopened = payload.status == "pending" and reminder.status != "pending"
    if payload.title is not None:
        reminder.title = payload.title
    if payload.remind_at is not None and payload.remind_at != reminder.remind_at:
        reminder.remind_at = payload.remind_at
        delivery_changed = True
        remind_at_changed = True
    if payload.email_enabled is not None:
        delivery_changed = delivery_changed or (
            payload.email_enabled != reminder.email_enabled
            or (payload.email_enabled and reminder.email_status == "failed")
        )
        reminder.email_enabled = payload.email_enabled
    if payload.status is not None and payload.status != reminder.status:
        reminder.status = payload.status
        if payload.status in {"completed", "canceled"}:
            reminder.completed_at = utc_now()
            if payload.status == "completed":
                reminder.triggered_at = reminder.triggered_at or reminder.completed_at
            reminder.cancellation_source = (
                "user" if payload.status == "canceled" else None
            )
            stop_email_delivery(reminder)
        elif payload.status == "pending":
            reminder.completed_at = None
            reminder.cancellation_source = None
            delivery_changed = True
    if reminder.status == "pending":
        if remind_at_changed or reopened:
            reminder.triggered_at = None
            # A trigger can commit after our initial read saw NULL. Force the
            # reset into this UPDATE even when the ORM saw no local change.
            flag_modified(reminder, "triggered_at")
        if delivery_changed:
            reset_email_delivery(reminder, force_resend=remind_at_changed)
    await db.commit()
    await db.refresh(reminder)
    if payload.status == "completed":
        await reward_reminder_action(
            db,
            current_user=current_user,
            reminder=reminder,
            action="reminder_completed",
        )
    return reminder


@router.post("/{reminder_id}/complete", response_model=ReminderResponse)
async def complete_reminder(
    reminder_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = await get_owned_reminder(reminder_id, current_user, db)
    if reminder.status == "completed":
        return reminder
    if reminder.status == "canceled":
        raise HTTPException(status_code=409, detail="Canceled reminder cannot be completed")

    now = utc_now()
    reminder.status = "completed"
    reminder.triggered_at = reminder.triggered_at or now
    reminder.completed_at = now
    reminder.cancellation_source = None
    stop_email_delivery(reminder)
    await db.commit()
    await db.refresh(reminder)
    await reward_reminder_action(
        db,
        current_user=current_user,
        reminder=reminder,
        action="reminder_completed",
    )
    return reminder


@router.post("/{reminder_id}/trigger", response_model=ReminderResponse)
async def trigger_reminder(
    reminder_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = utc_now()
    # A desktop poll may finish after the user moves or cancels the reminder.
    # Check eligibility in the write itself, not against an earlier snapshot.
    result = await db.execute(
        update(Reminder)
        .where(
            Reminder.id == reminder_id,
            Reminder.user_id == current_user.id,
            Reminder.status == "pending",
            Reminder.remind_at <= now,
            Reminder.triggered_at.is_(None),
        )
        .values(triggered_at=now)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 1:
        await db.commit()
        return await get_owned_reminder(reminder_id, current_user, db)

    reminder = await get_owned_reminder(reminder_id, current_user, db)
    if reminder.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending reminders can be triggered")
    if reminder.remind_at > now:
        raise HTTPException(status_code=409, detail="Reminder is not due yet")
    if reminder.triggered_at is None:
        raise HTTPException(status_code=409, detail="Reminder changed before it could be triggered")
    return reminder
