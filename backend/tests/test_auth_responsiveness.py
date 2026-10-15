"""Password work must not stall unrelated requests on the async server."""
import asyncio
from datetime import timedelta
import threading

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api.v1 import admin, auth
from app.core.security import create_access_token, get_password_hash, verify_password
from app.core.time import utc_now
from app.main import app
from app.models.database import User, VerificationCode, async_session_maker


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as connection:
            yield connection


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["login", "register", "reset", "change", "admin-create", "admin-update"])
async def test_password_work_leaves_health_responsive(client, monkeypatch, operation):
    name = f"responsive-{operation}"
    email = f"{name}@example.com"
    original_password = "OriginalPassword123!"
    new_password = "UpdatedPassword123!"
    async with async_session_maker() as db:
        user = User(username=name, email=email, hashed_password=get_password_hash(original_password))
        db.add(user)
        await db.flush()
        user_id = user.id
        admin_user = (await db.execute(select(User).where(User.username == "admin"))).scalar_one()
        admin_id = admin_user.id
        if operation in {"register", "reset"}:
            code_email = f"new-{email}" if operation == "register" else email
            db.add(VerificationCode(
                email=code_email, code="654321", purpose="register" if operation == "register" else "reset_password",
                user_id=user_id if operation == "reset" else None, expires_at=utc_now() + timedelta(minutes=5),
            ))
        await db.commit()

    token = create_access_token({"sub": str(admin_id if operation.startswith("admin-") else user_id)})
    headers = {"Authorization": f"Bearer {token}"}
    if operation == "login":
        request = lambda: client.post("/api/v1/auth/login", data={"username": name, "password": original_password})
    elif operation == "register":
        request = lambda: client.post("/api/v1/auth/register", json={
            "username": f"new-{name}", "email": f"new-{email}", "password": new_password, "verification_code": "654321",
        })
    elif operation == "reset":
        request = lambda: client.post("/api/v1/auth/reset-password", json={
            "email": email, "verification_code": "654321", "new_password": new_password,
        })
    elif operation == "change":
        request = lambda: client.post("/api/v1/auth/change-password", headers=headers, json={
            "current_password": original_password, "new_password": new_password,
        })
    elif operation == "admin-create":
        request = lambda: client.post("/api/v1/admin/users", headers=headers, json={
            "username": f"new-{name}", "email": f"new-{email}", "password": new_password,
        })
    else:
        request = lambda: client.put(f"/api/v1/admin/users/{user_id}", headers=headers, json={
            "username": name, "email": email, "password": new_password, "status": "active", "is_superuser": False,
        })

    # Hold actual password work in a worker; no timing benchmark or external I/O.
    # The deadline only releases an old, blocking implementation to fail cleanly.
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    module = admin if operation.startswith("admin-") else auth
    function_name = "verify_password" if operation in {"login", "change"} else "get_password_hash"
    original = getattr(module, function_name)
    thread_ids = []

    def controlled_password_work(*args):
        thread_ids.append(threading.get_ident())
        entered.set()
        try:
            release.wait(timeout=2)
            return original(*args)
        finally:
            finished.set()

    monkeypatch.setattr(module, function_name, controlled_password_work)
    task = asyncio.create_task(request())
    try:
        assert await asyncio.to_thread(entered.wait, 3), "password calculation was never reached"
        assert not finished.is_set(), "password calculation blocked the request event loop"
        assert len(thread_ids) == 1
        assert thread_ids[0] != threading.get_ident(), "password calculation must run off the request event loop"
        assert (await client.get("/health")).status_code == 200
        assert not finished.is_set(), "health must finish while password calculation is pending"
    finally:
        release.set()
        response = await task
    assert response.status_code == (201 if operation == "admin-create" else 200)
    if operation != "login":
        changed_email = f"new-{email}" if operation in {"register", "admin-create"} else email
        async with async_session_maker() as db:
            changed = (await db.execute(select(User).where(User.email == changed_email))).scalar_one()
            assert verify_password(new_password, changed.hashed_password)
