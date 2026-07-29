from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


PetType = Literal["cat", "dog", "pig"]
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
