from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field


PetType = Literal["cat", "dog", "pig"]
UserStatus = Literal["active", "disabled"]


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    verification_code: str = Field(min_length=6, max_length=6)


class UserLogin(BaseModel):
    username: str
    password: str


class UserPreferenceBase(BaseModel):
    pet_type: PetType = "cat"
    quick_chat_enabled: bool = True
    bubble_frequency: int = Field(default=120, ge=30, le=3600)


class UserPreferenceUpdate(UserPreferenceBase):
    pass


class UserPreferenceResponse(UserPreferenceBase):
    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserResponse(BaseModel):
    username: str
    email: EmailStr
    id: int
    status: UserStatus
    is_active: bool
    is_superuser: bool
    created_at: datetime
    last_login_at: Optional[datetime] = None
    preferences: Optional[UserPreferenceResponse] = None

    model_config = {"from_attributes": True}


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: Optional[str] = None


class VerificationCodeRequest(BaseModel):
    email: EmailStr


class MessageResponse(BaseModel):
    message: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    verification_code: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8, max_length=72)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=72)
    new_password: str = Field(min_length=8, max_length=72)
