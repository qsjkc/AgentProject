from datetime import datetime, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

from app.core.config import settings


PetType = Literal["cat", "dog", "pig"]
ReminderStatus = Literal["pending", "completed", "canceled"]
ReminderRecurrenceType = Literal["once", "daily", "weekdays", "weekly"]
ReminderCreationSource = Literal["user", "recurrence"]
ReminderCancellationSource = Literal["user", "series_pause", "series_cancel"]
ReminderSeriesStatus = Literal["active", "paused", "canceled"]
ReminderEmailStatus = Literal[
    "pending",
    "sending",
    "retrying",
    "sent",
    "failed",
    "disabled",
    "canceled",
]


def normalize_reminder_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def serialize_utc_datetime(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    aware_utc = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return aware_utc.isoformat().replace("+00:00", "Z")


class ReminderCreate(BaseModel):
    pet_type: PetType
    title: str = Field(min_length=1, max_length=200)
    source_text: Optional[str] = Field(default=None, max_length=1000)
    remind_at: datetime
    email_enabled: bool = True
    recurrence_type: ReminderRecurrenceType = "once"
    recurrence_timezone: Optional[str] = Field(default=None, max_length=64)

    @field_validator("remind_at", mode="after")
    @classmethod
    def normalize_remind_at(cls, value: datetime) -> datetime:
        return normalize_reminder_datetime(value)

    @model_validator(mode="after")
    def validate_recurrence_timezone(self) -> "ReminderCreate":
        if self.recurrence_type == "once":
            self.recurrence_timezone = None
            return self
        timezone_name = self.recurrence_timezone or settings.PET_REWARD_TIMEZONE
        try:
            ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("Unknown recurrence timezone") from exc
        self.recurrence_timezone = timezone_name
        return self


class ReminderUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    remind_at: Optional[datetime] = None
    status: Optional[ReminderStatus] = None
    email_enabled: Optional[bool] = None

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
    cancellation_source: Optional[ReminderCancellationSource] = None
    series_id: Optional[int] = None
    recurrence_type: ReminderRecurrenceType
    occurrence_sequence: Optional[int] = None
    creation_source: ReminderCreationSource
    email_enabled: bool
    email_status: ReminderEmailStatus
    email_sent_at: Optional[datetime] = None
    email_attempt_count: int
    created_at: datetime
    updated_at: datetime

    @field_serializer(
        "remind_at",
        "triggered_at",
        "completed_at",
        "email_sent_at",
        "created_at",
        "updated_at",
    )
    def serialize_datetimes(self, value: Optional[datetime]) -> Optional[str]:
        return serialize_utc_datetime(value)

    model_config = {"from_attributes": True}


class PendingReminderSummary(BaseModel):
    pet_type: PetType
    pending_count: int


class ReminderSeriesResponse(BaseModel):
    id: int
    user_id: int
    pet_type: PetType
    title: str
    source_text: Optional[str] = None
    recurrence_type: Literal["daily", "weekdays", "weekly"]
    timezone: str
    local_hour: int = Field(ge=0, le=23)
    local_minute: int = Field(ge=0, le=59)
    weekdays: list[int]
    status: ReminderSeriesStatus
    email_enabled: bool
    next_occurrence_at: datetime
    next_sequence: int = Field(ge=2)
    last_materialized_at: Optional[datetime] = None
    skipped_occurrence_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime

    @field_serializer(
        "next_occurrence_at",
        "last_materialized_at",
        "created_at",
        "updated_at",
    )
    def serialize_datetimes(self, value: Optional[datetime]) -> Optional[str]:
        return serialize_utc_datetime(value)

    model_config = {"from_attributes": True}
