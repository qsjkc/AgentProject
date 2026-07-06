from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


PetType = Literal["cat", "dog", "pig"]
ReminderStatus = Literal["pending", "completed", "canceled"]


def normalize_reminder_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class ReminderCreate(BaseModel):
    pet_type: PetType
    title: str = Field(min_length=1, max_length=200)
    source_text: Optional[str] = Field(default=None, max_length=1000)
    remind_at: datetime

    @field_validator("remind_at", mode="after")
    @classmethod
    def normalize_remind_at(cls, value: datetime) -> datetime:
        return normalize_reminder_datetime(value)


class ReminderUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    remind_at: Optional[datetime] = None
    status: Optional[ReminderStatus] = None

    @field_validator("remind_at", mode="after")
    @classmethod
    def normalize_remind_at(cls, value: Optional[datetime]) -> Optional[datetime]:
        return normalize_reminder_datetime(value) if value is not None else None


class ReminderResponse(BaseModel):
    id: int
    user_id: int
    pet_type: PetType
    title: str
    source_text: Optional[str] = None
    remind_at: datetime
    status: ReminderStatus
    triggered_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PendingReminderSummary(BaseModel):
    pet_type: PetType
    pending_count: int
