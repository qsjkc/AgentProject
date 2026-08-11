from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


PetType = Literal["cat", "dog", "pig"]
PetRewardAction = Literal[
    "daily_first_wake",
    "poke",
    "drag_release",
    "pat",
    "feed",
    "clean",
    "dress_up",
    "reminder_created",
    "reminder_completed",
    "meaningful_chat",
]
PetRewardReason = Literal[
    "awarded",
    "duplicate",
    "cooldown",
    "action_daily_cap",
    "daily_cap",
    "max_level",
]
RelationshipStage = Literal[
    "new_friend",
    "getting_familiar",
    "clingy",
    "trusted_partner",
    "deep_bond",
]
OutfitSlot = Literal["head", "neck", "side", "scene"]


class PetRelationshipProgress(BaseModel):
    current: int = Field(ge=0)
    required: int = Field(ge=0)
    percent: float = Field(ge=0, le=100)


class PetOutfitState(BaseModel):
    unlocked_outfit_ids: list[str]
    equipped_outfits: dict[OutfitSlot, str]


class PetRelationshipResponse(BaseModel):
    id: int
    user_id: int
    pet_type: PetType
    intimacy_xp: int = Field(ge=0)
    level: int = Field(ge=1, le=5)
    relationship_stage: RelationshipStage
    current_mood: str
    progress: PetRelationshipProgress
    outfit: PetOutfitState
    last_active_at: Optional[datetime] = None
    last_greeting_at: Optional[datetime] = None
    last_level_up_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class PetRelationshipRewardRequest(BaseModel):
    action: PetRewardAction
    idempotency_key: str = Field(min_length=1, max_length=128)


class PetOutfitUpdateRequest(BaseModel):
    slot: OutfitSlot
    item_id: Optional[str] = Field(default=None, max_length=64)


class PetRelationshipRewardResponse(BaseModel):
    action: PetRewardAction
    requested_xp: int = Field(ge=0)
    awarded_xp: int = Field(ge=0)
    reason: PetRewardReason
    cooldown_remaining_seconds: int = Field(default=0, ge=0)
    action_daily_awarded_xp: int = Field(ge=0)
    daily_awarded_xp: int = Field(ge=0)
    level_up: bool = False
    relationship: PetRelationshipResponse


class PetDailySummaryResponse(BaseModel):
    pet_type: PetType
    local_date: date
    timezone: str
    interaction_count: int = Field(ge=0)
    xp_gained: int = Field(ge=0)
    action_counts: dict[str, int]
    care_count: int = Field(ge=0)
    meaningful_chat_count: int = Field(ge=0)
    reminders_created_count: int = Field(ge=0)
    reminders_completed_count: int = Field(ge=0)
    first_interaction_at: Optional[datetime] = None
    last_interaction_at: Optional[datetime] = None


class PetWeeklySummarySeenRequest(BaseModel):
    review_key: str = Field(
        min_length=21,
        max_length=21,
        pattern=r"^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$",
    )


class PetWeeklySummaryResponse(BaseModel):
    pet_type: PetType
    review_key: str
    week_start: date
    week_end: date
    timezone: str
    eligible: bool
    is_new: bool
    reviewed_at: Optional[datetime] = None
    active_days: int = Field(ge=0, le=7)
    interaction_count: int = Field(ge=0)
    xp_gained: int = Field(ge=0)
    action_counts: dict[str, int]
    care_count: int = Field(ge=0)
    meaningful_chat_count: int = Field(ge=0)
    reminders_created_count: int = Field(ge=0)
    reminders_completed_count: int = Field(ge=0)
    level_at_start: int = Field(ge=1, le=5)
    level_at_end: int = Field(ge=1, le=5)
    levels_gained: int = Field(ge=0, le=4)
    relationship_stage_at_end: RelationshipStage
    first_interaction_at: Optional[datetime] = None
    last_interaction_at: Optional[datetime] = None
