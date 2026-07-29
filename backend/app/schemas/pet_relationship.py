from datetime import datetime
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


class PetRelationshipProgress(BaseModel):
    current: int = Field(ge=0)
    required: int = Field(ge=0)
    percent: float = Field(ge=0, le=100)


class PetRelationshipResponse(BaseModel):
    id: int
    user_id: int
    pet_type: PetType
    intimacy_xp: int = Field(ge=0)
    level: int = Field(ge=1, le=5)
    relationship_stage: RelationshipStage
    current_mood: str
    progress: PetRelationshipProgress
    last_active_at: Optional[datetime] = None
    last_greeting_at: Optional[datetime] = None
    last_level_up_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class PetRelationshipRewardRequest(BaseModel):
    action: PetRewardAction
    idempotency_key: str = Field(min_length=1, max_length=128)


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
