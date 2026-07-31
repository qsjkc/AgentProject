from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.time import utc_now
from app.models.database import Reminder, ReminderSeries, get_db
from app.models.user import User
from app.schemas.reminder import (
    PetType,
    ReminderSeriesResponse,
    ReminderSeriesStatus,
)
from app.services.reminder_state import reset_email_delivery, stop_email_delivery


router = APIRouter(prefix="/reminder-series", tags=["reminder-series"])


async def get_owned_series(
    series_id: int,
    current_user: User,
    db: AsyncSession,
) -> ReminderSeries:
    result = await db.execute(
        select(ReminderSeries).where(
            ReminderSeries.id == series_id,
            ReminderSeries.user_id == current_user.id,
        )
    )
    series = result.scalar_one_or_none()
    if series is None:
        raise HTTPException(status_code=404, detail="Reminder series not found")
    return series


async def cancel_untriggered_occurrences(
    db: AsyncSession,
    series: ReminderSeries,
    *,
    cancellation_source: str,
) -> None:
    status_filter = Reminder.status == "pending"
    if cancellation_source == "series_cancel":
        status_filter = or_(
            status_filter,
            and_(
                Reminder.status == "canceled",
                Reminder.cancellation_source == "series_pause",
            ),
        )
    result = await db.execute(
        select(Reminder).where(
            Reminder.series_id == series.id,
            status_filter,
            Reminder.triggered_at.is_(None),
        )
    )
    now = utc_now()
    for reminder in result.scalars():
        reminder.status = "canceled"
        reminder.completed_at = now
        reminder.cancellation_source = cancellation_source
        stop_email_delivery(reminder)


async def restore_paused_future_occurrences(
    db: AsyncSession,
    series: ReminderSeries,
) -> None:
    result = await db.execute(
        select(Reminder).where(
            Reminder.series_id == series.id,
            Reminder.status == "canceled",
            Reminder.cancellation_source == "series_pause",
            Reminder.remind_at > utc_now(),
        )
    )
    for reminder in result.scalars():
        reminder.status = "pending"
        reminder.completed_at = None
        reminder.cancellation_source = None
        reset_email_delivery(reminder)


@router.get("", response_model=List[ReminderSeriesResponse])
async def list_reminder_series(
    pet_type: Optional[PetType] = Query(default=None),
    status: Optional[ReminderSeriesStatus] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(ReminderSeries).where(ReminderSeries.user_id == current_user.id)
    if pet_type:
        query = query.where(ReminderSeries.pet_type == pet_type)
    if status:
        query = query.where(ReminderSeries.status == status)
    query = query.order_by(ReminderSeries.created_at.desc(), ReminderSeries.id.desc())
    result = await db.execute(query)
    return result.scalars().all()


@router.post("/{series_id}/pause", response_model=ReminderSeriesResponse)
async def pause_reminder_series(
    series_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    series = await get_owned_series(series_id, current_user, db)
    if series.status == "canceled":
        raise HTTPException(status_code=409, detail="Canceled reminder series cannot be paused")
    if series.status != "paused":
        series.status = "paused"
        await cancel_untriggered_occurrences(
            db,
            series,
            cancellation_source="series_pause",
        )
        await db.commit()
        await db.refresh(series)
    return series


@router.post("/{series_id}/resume", response_model=ReminderSeriesResponse)
async def resume_reminder_series(
    series_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    series = await get_owned_series(series_id, current_user, db)
    if series.status == "canceled":
        raise HTTPException(status_code=409, detail="Canceled reminder series cannot be resumed")
    if series.status != "active":
        series.status = "active"
        await restore_paused_future_occurrences(db, series)
        await db.commit()
        await db.refresh(series)
    return series


@router.post("/{series_id}/cancel", response_model=ReminderSeriesResponse)
async def cancel_reminder_series(
    series_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    series = await get_owned_series(series_id, current_user, db)
    if series.status != "canceled":
        series.status = "canceled"
        await cancel_untriggered_occurrences(
            db,
            series,
            cancellation_source="series_cancel",
        )
        await db.commit()
        await db.refresh(series)
    return series
