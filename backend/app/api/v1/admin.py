from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import get_current_superuser, get_password_hash
from app.models.database import UserPreference, get_db
from app.models.document import Document
from app.models.user import User, VerificationCode
from app.schemas.admin import (
    AdminOverviewResponse,
    AdminUserCreate,
    AdminUserListItem,
    AdminUserListResponse,
    AdminUserStatusUpdate,
    AdminUserUpdate,
)
from app.schemas.user import MessageResponse
from app.services.rag import rag_service

router = APIRouter(prefix="/admin", tags=["admin"])


async def ensure_user_preferences(user_id: int, db: AsyncSession) -> UserPreference:
    result = await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))
    preferences = result.scalar_one_or_none()
    if preferences:
        return preferences

    preferences = UserPreference(user_id=user_id)
    db.add(preferences)
    await db.flush()
    return preferences


async def get_document_counts(user_ids: list[int], db: AsyncSession) -> dict[int, int]:
    if not user_ids:
        return {}

    result = await db.execute(
        select(Document.user_id, func.count(Document.id))
        .where(Document.user_id.in_(user_ids))
        .group_by(Document.user_id)
    )
    return {user_id: count for user_id, count in result.all()}


async def build_admin_user_item(user: User, db: AsyncSession) -> AdminUserListItem:
    document_count = (
        await db.execute(select(func.count(Document.id)).where(Document.user_id == user.id))
    ).scalar_one() or 0
    return AdminUserListItem.model_validate(
        {
            **AdminUserListItem.model_validate(user, from_attributes=True).model_dump(),
            "document_count": document_count,
        }
    )


async def delete_user_artifacts(user_id: int, db: AsyncSession) -> None:
    result = await db.execute(select(Document).where(Document.user_id == user_id))
    documents = result.scalars().all()

    for document in documents:
        rag_service.delete_document(document.id)
        file_path = Path(document.file_path)
        if file_path.exists():
            file_path.unlink()


async def get_user_or_404(user_id: int, db: AsyncSession) -> User:
    result = await db.execute(
        select(User).options(selectinload(User.preferences)).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def ensure_unique_identity(
    *,
    username: str,
    email: str,
    db: AsyncSession,
    exclude_user_id: int | None = None,
) -> None:
    query = select(User).where(or_(User.username == username, User.email == email))
    if exclude_user_id is not None:
        query = query.where(User.id != exclude_user_id)

    existing = (await db.execute(query)).scalar_one_or_none()
    if existing:
        detail = "Username already registered" if existing.username == username else "Email already registered"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def apply_user_state(user: User, *, status_value: str, is_superuser: bool) -> None:
    user.status = status_value
    user.is_active = status_value == "active"
    user.is_superuser = is_superuser


@router.get("/overview", response_model=AdminOverviewResponse)
async def get_overview(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> AdminOverviewResponse:
    total_users = (await db.execute(select(func.count(User.id)))).scalar_one() or 0
    active_users = (
        await db.execute(select(func.count(User.id)).where(User.status == "active", User.is_active.is_(True)))
    ).scalar_one() or 0
    disabled_users = (
        await db.execute(select(func.count(User.id)).where(User.status == "disabled"))
    ).scalar_one() or 0
    admin_users = (
        await db.execute(select(func.count(User.id)).where(User.is_superuser.is_(True)))
    ).scalar_one() or 0
    total_documents = (await db.execute(select(func.count(Document.id)))).scalar_one() or 0

    return AdminOverviewResponse(
        total_users=total_users,
        active_users=active_users,
        disabled_users=disabled_users,
        total_documents=total_documents,
        admin_users=admin_users,
    )


@router.get("/users", response_model=AdminUserListResponse)
async def get_users(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
    search: str | None = Query(default=None),
    status: str | None = Query(default=None, pattern="^(active|disabled)?$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> AdminUserListResponse:
    filters = []
    if search:
        keyword = f"%{search}%"
        filters.append(or_(User.username.ilike(keyword), User.email.ilike(keyword)))
    if status:
        filters.append(User.status == status)

    total_query = select(func.count(User.id))
    if filters:
        total_query = total_query.where(*filters)
    total = (await db.execute(total_query)).scalar_one() or 0

    query = (
        select(User)
        .options(selectinload(User.preferences))
        .order_by(User.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    if filters:
        query = query.where(*filters)

    users = (await db.execute(query)).scalars().all()
    document_counts = await get_document_counts([user.id for user in users], db)

    items = [
        AdminUserListItem.model_validate(
            {
                **AdminUserListItem.model_validate(user, from_attributes=True).model_dump(),
                "document_count": document_counts.get(user.id, 0),
            }
        )
        for user in users
    ]

    return AdminUserListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        search=search,
        status=status,
    )


@router.get("/users/{user_id}", response_model=AdminUserListItem)
async def get_user_detail(
    user_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListItem:
    user = await get_user_or_404(user_id, db)
    return await build_admin_user_item(user, db)


@router.post("/users", response_model=AdminUserListItem, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: AdminUserCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListItem:
    await ensure_unique_identity(username=payload.username, email=payload.email, db=db)

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
    )
    apply_user_state(user, status_value=payload.status, is_superuser=payload.is_superuser)
    db.add(user)
    await db.flush()
    await ensure_user_preferences(user.id, db)
    await db.commit()

    created_user = await get_user_or_404(user.id, db)
    return await build_admin_user_item(created_user, db)


@router.put("/users/{user_id}", response_model=AdminUserListItem)
async def update_user(
    user_id: int,
    payload: AdminUserUpdate,
    current_admin: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListItem:
    user = await get_user_or_404(user_id, db)
    await ensure_unique_identity(
        username=payload.username,
        email=payload.email,
        db=db,
        exclude_user_id=user.id,
    )

    if current_admin.id == user.id and payload.status == "disabled":
        raise HTTPException(status_code=400, detail="You cannot disable your own account")
    if current_admin.id == user.id and not payload.is_superuser:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin role")

    user.username = payload.username
    user.email = payload.email
    apply_user_state(user, status_value=payload.status, is_superuser=payload.is_superuser)
    if payload.password:
        user.hashed_password = get_password_hash(payload.password)

    await ensure_user_preferences(user.id, db)
    await db.commit()

    updated_user = await get_user_or_404(user.id, db)
    return await build_admin_user_item(updated_user, db)


@router.patch("/users/{user_id}/status", response_model=AdminUserListItem)
async def update_user_status(
    user_id: int,
    payload: AdminUserStatusUpdate,
    current_admin: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListItem:
    if current_admin.id == user_id and payload.status == "disabled":
        raise HTTPException(status_code=400, detail="You cannot disable your own account")

    user = await get_user_or_404(user_id, db)
    apply_user_state(user, status_value=payload.status, is_superuser=user.is_superuser)
    await db.commit()

    refreshed_user = await get_user_or_404(user.id, db)
    return await build_admin_user_item(refreshed_user, db)


@router.delete("/users/{user_id}", response_model=MessageResponse)
async def delete_user(
    user_id: int,
    current_admin: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    if current_admin.id == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    user = await get_user_or_404(user_id, db)
    await delete_user_artifacts(user.id, db)
    await db.execute(
        delete(VerificationCode).where(
            or_(VerificationCode.user_id == user.id, VerificationCode.email == user.email)
        )
    )
    await db.delete(user)
    await db.commit()
    return MessageResponse(message="User deleted")
