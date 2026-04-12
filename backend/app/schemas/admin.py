from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field

from app.schemas.user import UserResponse


AdminUserStatus = Literal["active", "disabled"]


class AdminOverviewResponse(BaseModel):
    total_users: int
    active_users: int
    disabled_users: int
    total_documents: int
    admin_users: int


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
