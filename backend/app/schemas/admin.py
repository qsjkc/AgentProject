from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field

from app.schemas.user import UserResponse


AdminUserStatus = Literal["active", "disabled"]
AdminPetType = Literal["cat", "dog", "pig"]


class AdminOverviewResponse(BaseModel):
    total_users: int
    active_users: int
    disabled_users: int
    total_documents: int
    admin_users: int


class AdminWeeklyReviewFunnelItem(BaseModel):
    review_key: str = Field(
        min_length=21,
        max_length=21,
        pattern=r"^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$",
    )
    generated_users: int = Field(ge=0)
    shown_users: int = Field(ge=0)
    seen_users: int = Field(ge=0)
    follow_up_users: int = Field(ge=0)
    follow_up_care_users: int = Field(ge=0)
    follow_up_chat_users: int = Field(ge=0)
    follow_up_reminder_users: int = Field(ge=0)
    shown_from_generated_rate: float = Field(ge=0, le=1)
    seen_from_shown_rate: float = Field(ge=0, le=1)
    follow_up_from_seen_rate: float = Field(ge=0, le=1)


class AdminWeeklyReviewFunnelResponse(BaseModel):
    pet_type: AdminPetType
    items: List[AdminWeeklyReviewFunnelItem]


class AdminUserListItem(UserResponse):
    document_count: int = 0


class AdminUserListResponse(BaseModel):
    items: List[AdminUserListItem]
    total: int
    page: int
    page_size: int
    search: Optional[str] = None
    status: Optional[AdminUserStatus] = None


class AdminUserStatusUpdate(BaseModel):
    status: AdminUserStatus


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    status: AdminUserStatus = "active"
    is_superuser: bool = False


class AdminUserUpdate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    password: Optional[str] = Field(default=None, min_length=8, max_length=72)
    status: AdminUserStatus
    is_superuser: bool = False
