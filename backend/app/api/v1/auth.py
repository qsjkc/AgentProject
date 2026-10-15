import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.concurrency import run_in_threadpool

from app.core.security import (
    create_access_token,
    get_current_user,
    get_password_hash,
    verify_password,
)
from app.core.time import utc_now
from app.models.database import UserPreference, get_db
from app.models.user import User, VerificationCode
from app.schemas.user import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    MessageResponse,
    ResetPasswordRequest,
    Token,
    UserCreate,
    UserResponse,
    VerificationCodeRequest,
)
from app.services.email import EmailDeliveryError, send_email
from app.services.user_preferences import get_or_create_preferences

router = APIRouter(prefix="/auth", tags=["auth"])


def generate_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


async def send_auth_email(email: str, subject: str, html_content: str) -> bool:
    try:
        return await send_email(email, subject, html_content)
    except EmailDeliveryError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to send verification email",
        ) from exc


async def issue_code(
    db: AsyncSession,
    *,
    email: str,
    purpose: str,
    user_id: int | None = None,
) -> str:
    code = generate_verification_code()
    await db.execute(
        delete(VerificationCode).where(
            VerificationCode.email == email,
            VerificationCode.purpose == purpose,
            VerificationCode.consumed_at.is_(None),
        )
    )
    db.add(
        VerificationCode(
            email=email,
            code=code,
            purpose=purpose,
            user_id=user_id,
            expires_at=utc_now() + timedelta(minutes=5),
        )
    )
    await db.commit()
    return code


async def get_valid_code(
    db: AsyncSession,
    *,
    email: str,
    purpose: str,
    code: str,
) -> VerificationCode:
    result = await db.execute(
        select(VerificationCode)
        .where(
            VerificationCode.email == email,
            VerificationCode.purpose == purpose,
            VerificationCode.code == code,
            VerificationCode.consumed_at.is_(None),
        )
        .order_by(VerificationCode.created_at.desc())
    )
    verification = result.scalars().first()
    if not verification:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid verification code")
    if verification.expires_at <= utc_now():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Verification code expired")
    return verification


async def consume_verification_code(db: AsyncSession, verification: VerificationCode) -> None:
    """Claim the code in the same transaction as the account change.

    A prior SELECT is insufficient: simultaneous requests may both validate it.
    Conditional UPDATE also rejects a code reissued or expired while waiting.
    The caller commits both writes, or get_db rolls both back on failure.
    """
    consumed_at = utc_now()
    result = await db.execute(
        update(VerificationCode)
        .where(
            VerificationCode.id == verification.id,
            VerificationCode.code == verification.code,
            VerificationCode.email == verification.email,
            VerificationCode.purpose == verification.purpose,
            VerificationCode.created_at == verification.created_at,
            VerificationCode.expires_at == verification.expires_at,
            VerificationCode.consumed_at.is_(None),
            VerificationCode.expires_at > consumed_at,
        )
        .values(consumed_at=consumed_at)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid verification code")


async def create_default_preferences(user_id: int, db: AsyncSession) -> UserPreference:
    preferences, _ = await get_or_create_preferences(user_id, db)
    return preferences


async def load_user_with_preferences(user_id: int, db: AsyncSession) -> User:
    result = await db.execute(
        select(User).options(selectinload(User.preferences)).where(User.id == user_id)
    )
    user = result.scalar_one()
    if not user.preferences:
        await create_default_preferences(user.id, db)
        await db.commit()
        await db.refresh(user, attribute_names=["preferences"])
    return user


@router.post("/send-verification-code", response_model=MessageResponse)
async def send_verification_code(
    payload: VerificationCodeRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    existing_user = await db.execute(select(User).where(User.email == payload.email))
    if existing_user.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    code = await issue_code(db, email=payload.email, purpose="register")
    await send_auth_email(
        payload.email,
        "Detachym 注册验证码",
        (
            "<p>你的 Detachym 注册验证码为：</p>"
            f"<p style='font-size:24px;font-weight:bold'>{code}</p>"
            "<p>验证码 5 分钟内有效。</p>"
        ),
    )
    return MessageResponse(message="Verification code sent")


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(
    payload: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()
    if user:
        code = await issue_code(db, email=payload.email, purpose="reset_password", user_id=user.id)
        await send_auth_email(
            payload.email,
            "Detachym 重置密码验证码",
            (
                "<p>你的 Detachym 重置密码验证码为：</p>"
                f"<p style='font-size:24px;font-weight:bold'>{code}</p>"
                "<p>验证码 5 分钟内有效。</p>"
            ),
        )
    return MessageResponse(message="If the account exists, a reset code has been sent")


@router.post("/register", response_model=UserResponse)
async def register(
    user_create: UserCreate,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    existing_username = await db.execute(select(User).where(User.username == user_create.username))
    if existing_username.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already registered")

    existing_email = await db.execute(select(User).where(User.email == user_create.email))
    if existing_email.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    verification = await get_valid_code(
        db,
        email=user_create.email,
        purpose="register",
        code=user_create.verification_code,
    )
    await consume_verification_code(db, verification)

    user = User(
        username=user_create.username,
        email=user_create.email,
        hashed_password=await run_in_threadpool(get_password_hash, user_create.password),
        status="active",
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await create_default_preferences(user.id, db)
    await db.commit()

    return await load_user_with_preferences(user.id, db)


@router.post("/login", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Token:
    identifier = form_data.username.strip()
    result = await db.execute(select(User).where(or_(User.username == identifier, User.email == identifier)))
    # Username and email are unique separately, so one identifier can match
    # two different accounts. Authenticate only an unambiguous password match.
    matches = []
    for candidate in result.scalars().all():
        if await run_in_threadpool(verify_password, form_data.password, candidate.hashed_password):
            matches.append(candidate)
    if len(matches) != 1:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = matches[0]
    if user.status != "active" or not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")

    user.last_login_at = utc_now()
    await db.commit()

    access_token = create_access_token(data={"sub": str(user.id), "username": user.username})
    return Token(access_token=access_token)


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    payload: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    verification = await get_valid_code(
        db,
        email=payload.email,
        purpose="reset_password",
        code=payload.verification_code,
    )
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if verification.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid verification code")

    await consume_verification_code(db, verification)
    user.hashed_password = await run_in_threadpool(get_password_hash, payload.new_password)
    await db.commit()
    return MessageResponse(message="Password reset successful")


@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    payload: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    if not await run_in_threadpool(verify_password, payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")

    current_user.hashed_password = await run_in_threadpool(get_password_hash, payload.new_password)
    await db.commit()
    return MessageResponse(message="Password updated")


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    return await load_user_with_preferences(current_user.id, db)
