"""Single-use verification codes must survive concurrent requests and rollback."""
import asyncio
from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.api.v1 import auth
from app.core.security import get_password_hash, verify_password
from app.core.time import utc_now
from app.main import app
from app.models.database import User, VerificationCode, async_session_maker


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as connection:
            yield connection


async def seed_code(name, *, purpose="reset_password", expires_at=None):
    email = f"{name}@example.com"
    async with async_session_maker() as db:
        user = None
        if purpose == "reset_password":
            user = User(username=name, email=email, hashed_password=get_password_hash("OriginalPassword123!"))
            db.add(user)
            await db.flush()
        db.add(VerificationCode(
            email=email, code="321098", purpose=purpose,
            user_id=user.id if user else None,
            expires_at=expires_at or utc_now() + timedelta(minutes=5),
        ))
        await db.commit()
    return email


def synchronize_validations(monkeypatch):
    original = auth.get_valid_code
    ready = asyncio.Event()
    arrived = 0

    async def synchronized(*args, **kwargs):
        nonlocal arrived
        code = await original(*args, **kwargs)
        arrived += 1
        if arrived == 2:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=5)
        return code

    monkeypatch.setattr(auth, "get_valid_code", synchronized)


@pytest.mark.asyncio
async def test_concurrent_reset_consumes_one_code_once(client, monkeypatch):
    email = await seed_code("atomic-reset")
    synchronize_validations(monkeypatch)
    passwords = ["FirstNewPassword123!", "SecondNewPassword123!"]
    responses = await asyncio.gather(*[
        client.post("/api/v1/auth/reset-password", json={
            "email": email, "verification_code": "321098", "new_password": password,
        }) for password in passwords
    ])
    assert sorted(response.status_code for response in responses) == [200, 400]
    winning_password = passwords[next(i for i, response in enumerate(responses) if response.status_code == 200)]
    async with async_session_maker() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert verify_password(winning_password, user.hashed_password)
        code = (await db.execute(select(VerificationCode).where(VerificationCode.email == email))).scalar_one()
        assert code.consumed_at is not None


@pytest.mark.asyncio
async def test_concurrent_registration_does_not_reuse_code_or_return_server_error(client, monkeypatch):
    email = await seed_code("atomic-register", purpose="register")
    synchronize_validations(monkeypatch)
    responses = await asyncio.gather(*[
        client.post("/api/v1/auth/register", json={
            "username": f"atomic-registration-{index}", "email": email,
            "password": "AccountPassword123!", "verification_code": "321098",
        }) for index in range(2)
    ])
    assert sorted(response.status_code for response in responses) == [200, 400]
    async with async_session_maker() as db:
        users = (await db.execute(select(User).where(User.email == email))).scalars().all()
        assert len(users) == 1


@pytest.mark.asyncio
async def test_expiry_boundary_does_not_change_password(client, monkeypatch):
    deadline = utc_now()
    email = await seed_code("exact-expiry", expires_at=deadline)
    monkeypatch.setattr(auth, "utc_now", lambda: deadline)
    response = await client.post("/api/v1/auth/reset-password", json={
        "email": email, "verification_code": "321098", "new_password": "LatePassword123!",
    })
    assert response.status_code == 400
    async with async_session_maker() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert verify_password("OriginalPassword123!", user.hashed_password)


@pytest.mark.asyncio
async def test_failed_password_update_rolls_back_code_claim(client, monkeypatch):
    email = await seed_code("reset-rollback")

    def fail_hash(_password):
        raise RuntimeError("simulated password storage failure")

    with monkeypatch.context() as patch:
        patch.setattr(auth, "get_password_hash", fail_hash)
        failed = await client.post("/api/v1/auth/reset-password", json={
            "email": email, "verification_code": "321098", "new_password": "RetryPassword123!",
        })
    assert failed.status_code == 500
    retry = await client.post("/api/v1/auth/reset-password", json={
        "email": email, "verification_code": "321098", "new_password": "RetryPassword123!",
    })
    assert retry.status_code == 200
    replay = await client.post("/api/v1/auth/reset-password", json={
        "email": email, "verification_code": "321098", "new_password": "ReplayPassword123!",
    })
    assert replay.status_code == 400


@pytest.mark.asyncio
async def test_reset_code_does_not_transfer_to_another_account_at_same_email(client):
    email = await seed_code("reset-reassigned-email")
    async with async_session_maker() as db:
        await db.execute(update(VerificationCode).where(VerificationCode.email == email).values(user_id=None))
        await db.commit()
    response = await client.post("/api/v1/auth/reset-password", json={
        "email": email, "verification_code": "321098", "new_password": "OtherAccountPassword123!",
    })
    assert response.status_code == 400
    async with async_session_maker() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert verify_password("OriginalPassword123!", user.hashed_password)


@pytest.mark.asyncio
async def test_code_expiring_between_validation_and_claim_is_rejected(client, monkeypatch):
    deadline = utc_now() + timedelta(minutes=5)
    email = await seed_code("expired-before-claim", expires_at=deadline)
    original = auth.get_valid_code

    async def expires_after_validation(*args, **kwargs):
        verification = await original(*args, **kwargs)
        monkeypatch.setattr(auth, "utc_now", lambda: deadline)
        return verification

    monkeypatch.setattr(auth, "get_valid_code", expires_after_validation)
    response = await client.post("/api/v1/auth/reset-password", json={
        "email": email, "verification_code": "321098", "new_password": "TooLatePassword123!",
    })
    assert response.status_code == 400
    async with async_session_maker() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert verify_password("OriginalPassword123!", user.hashed_password)
