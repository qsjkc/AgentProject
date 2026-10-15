from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.core.security import create_access_token, get_password_hash
from app.main import app
from app.models.database import User, UserPreference, async_session_maker


@pytest.fixture
async def identity_client():
    # tests/conftest.py selects the temporary database before these imports.
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client


async def create_identity(*, username, email, password="Password123!", **state):
    async with async_session_maker() as session:
        user = User(username=username, email=email, hashed_password=get_password_hash(password), **state)
        session.add(user)
        await session.flush()
        session.add(UserPreference(user_id=user.id))
        await session.commit()
        return user


async def identity_snapshot():
    async with async_session_maker() as session:
        snapshot = []
        for model in (User, UserPreference):
            result = await session.execute(select(model.__table__).order_by(model.id))
            snapshot.append(tuple(result.all()))
        return tuple(snapshot)


async def login(client, identifier, password):
    return await client.post(
        "/api/v1/auth/login", data={"username": identifier, "password": password}
    )


async def assert_token_owner(client, response, expected_user):
    assert response.status_code == 200
    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {response.json()['access_token']}"},
    )
    assert me.status_code == 200
    assert me.json()["id"] == expected_user.id
    assert me.json()["username"] == expected_user.username


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize("conflict", ["both", "username", "email"])
async def test_admin_identity_conflicts_return_400_without_database_changes(identity_client, operation, conflict):
    prefix = "identity-admin-" + uuid4().hex[:8]
    admin = await create_identity(username=prefix + "-admin", email=prefix + "-admin@example.com", is_superuser=True)
    first = await create_identity(username=prefix + "-first", email=prefix + "-first@example.com")
    second = await create_identity(username=prefix + "-second", email=prefix + "-second@example.com")
    target = await create_identity(username=prefix + "-target", email=prefix + "-target@example.com")
    token = create_access_token({"sub": str(admin.id), "username": admin.username})
    before = await identity_snapshot()
    payload = {
        "username": first.username if conflict in {"both", "username"} else prefix + "-unused",
        "email": second.email if conflict in {"both", "email"} else prefix + "-unused@example.com",
        "password": "ChangedPassword123!",
        "status": "disabled",
        "is_superuser": True,
    }
    url = "/api/v1/admin/users" + (f"/{target.id}" if operation == "update" else "")
    response = await identity_client.request(
        "PUT" if operation == "update" else "POST",
        url,
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    assert response.status_code == 400
    expected = "Email already registered" if conflict == "email" else "Username already registered"
    assert response.json()["detail"] == expected
    assert await identity_snapshot() == before


async def test_admin_update_keeps_own_identity_without_false_conflict(identity_client):
    prefix = "identity-self-" + uuid4().hex[:8]
    admin = await create_identity(username=prefix, email=prefix + "@example.com", is_superuser=True)
    token = create_access_token({"sub": str(admin.id), "username": admin.username})
    response = await identity_client.put(
        f"/api/v1/admin/users/{admin.id}",
        headers={"Authorization": f"Bearer {token}"},
        json={"username": admin.username, "email": admin.email, "status": "active", "is_superuser": True},
    )
    assert response.status_code == 200
    assert response.json()["id"] == admin.id
    assert response.json()["username"] == admin.username
    assert response.json()["email"] == admin.email


async def create_overlapping_identities(*, same_password=False, first_state=None):
    prefix = "overlap-" + uuid4().hex[:8]
    identifier = prefix + "@example.com"
    first = await create_identity(
        username=identifier, email=prefix + "-first@example.com", password="FirstPassword123!", **(first_state or {})
    )
    second = await create_identity(
        username=prefix + "-second", email=identifier,
        password="FirstPassword123!" if same_password else "SecondPassword123!",
    )
    return identifier, first, second


@pytest.mark.parametrize("side,password", [(0, "FirstPassword123!"), (1, "SecondPassword123!")])
async def test_overlapping_username_and_email_authenticate_only_matching_password(identity_client, side, password):
    identifier, first, second = await create_overlapping_identities()
    response = await login(identity_client, identifier, password)
    await assert_token_owner(identity_client, response, (first, second)[side])
    async with async_session_maker() as session:
        untouched = await session.get(User, (second, first)[side].id)
        assert untouched.last_login_at is None


@pytest.mark.parametrize("same_password,password", [(True, "FirstPassword123!"), (False, "WrongPassword123!")])
async def test_ambiguous_or_wrong_password_is_unauthorized_without_login_updates(identity_client, same_password, password):
    identifier, _, _ = await create_overlapping_identities(same_password=same_password)
    before = await identity_snapshot()
    response = await login(identity_client, identifier, password)
    assert response.status_code == 401
    assert response.json()["detail"] == "Incorrect username or password"
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert "access_token" not in response.json()
    assert await identity_snapshot() == before


@pytest.mark.parametrize("state", [{"status": "disabled"}, {"is_active": False}])
async def test_disabled_unique_password_match_is_forbidden_without_falling_back(identity_client, state):
    identifier, _, _ = await create_overlapping_identities(first_state=state)
    before = await identity_snapshot()
    response = await login(identity_client, identifier, "FirstPassword123!")
    assert response.status_code == 403
    assert response.json()["detail"] == "User is disabled"
    assert "access_token" not in response.json()
    assert await identity_snapshot() == before


@pytest.mark.parametrize("field", ["username", "email"])
async def test_ordinary_username_and_email_login_still_identify_the_same_user(identity_client, field):
    prefix = "ordinary-" + uuid4().hex[:8]
    user = await create_identity(username=prefix, email=prefix + "@example.com")
    response = await login(identity_client, getattr(user, field), "Password123!")
    await assert_token_owner(identity_client, response, user)
