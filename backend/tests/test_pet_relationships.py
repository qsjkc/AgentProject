import os
import shutil
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

TEST_ROOT = Path(__file__).resolve().parent / ".runtime-pet-relationships"
if TEST_ROOT.exists():
    shutil.rmtree(TEST_ROOT)
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(TEST_ROOT / 'test.db').as_posix()}"
os.environ["CHROMA_PERSIST_DIR"] = str(TEST_ROOT / "chroma")
os.environ["UPLOAD_DIR"] = str(TEST_ROOT / "uploads")
os.environ["DOWNLOAD_DIR"] = str(TEST_ROOT / "downloads")
os.environ["SMTP_USER"] = ""
os.environ["SMTP_PASSWORD"] = ""
os.environ["INITIAL_ADMIN_USERNAME"] = "admin"
os.environ["INITIAL_ADMIN_EMAIL"] = "admin@example.com"
os.environ["INITIAL_ADMIN_PASSWORD"] = "ChangeThisPassword123!"

from app.main import app  # noqa: E402
from app.services.pet_relationships import (  # noqa: E402
    get_relationship_level,
    get_relationship_progress,
)


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def register_and_login(client: AsyncClient, username: str, email: str) -> dict[str, str]:
    response = await client.post("/api/v1/auth/send-verification-code", json={"email": email})
    assert response.status_code == 200

    from app.models.database import async_session_maker  # noqa: E402
    from app.models.user import VerificationCode  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async with async_session_maker() as session:
        result = await session.execute(
            select(VerificationCode)
            .where(VerificationCode.email == email, VerificationCode.purpose == "register")
            .order_by(VerificationCode.created_at.desc())
        )
        code = result.scalars().first()
        assert code is not None

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "email": email,
            "password": "Password123!",
            "verification_code": code.code,
        },
    )
    assert response.status_code == 200

    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": "Password123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_relationship_level_and_progress_follow_product_curve():
    assert get_relationship_level(0) == (1, "new_friend")
    assert get_relationship_level(99) == (1, "new_friend")
    assert get_relationship_level(100) == (2, "getting_familiar")
    assert get_relationship_level(260) == (3, "clingy")
    assert get_relationship_level(520) == (4, "trusted_partner")
    assert get_relationship_level(900) == (5, "deep_bond")

    assert get_relationship_progress(99) == {
        "current": 99,
        "required": 100,
        "percent": 99.0,
    }
    assert get_relationship_progress(145) == {
        "current": 45,
        "required": 160,
        "percent": 28.12,
    }
    assert get_relationship_progress(900) == {
        "current": 0,
        "required": 0,
        "percent": 100.0,
    }


@pytest.mark.asyncio
async def test_relationship_is_created_per_user_and_pet(client: AsyncClient):
    unauthenticated = await client.get("/api/v1/pets/pig/relationship")
    assert unauthenticated.status_code == 401

    alice_headers = await register_and_login(client, "alice-pet", "alice-pet@example.com")
    bob_headers = await register_and_login(client, "bob-pet", "bob-pet@example.com")

    pig = await client.get("/api/v1/pets/pig/relationship", headers=alice_headers)
    assert pig.status_code == 200
    assert pig.json()["pet_type"] == "pig"
    assert pig.json()["intimacy_xp"] == 0
    assert pig.json()["level"] == 1
    assert pig.json()["relationship_stage"] == "new_friend"
    assert pig.json()["progress"] == {
        "current": 0,
        "required": 100,
        "percent": 0.0,
    }

    same_pig = await client.get("/api/v1/pets/pig/relationship", headers=alice_headers)
    assert same_pig.status_code == 200
    assert same_pig.json()["id"] == pig.json()["id"]

    cat = await client.get("/api/v1/pets/cat/relationship", headers=alice_headers)
    assert cat.status_code == 200
    assert cat.json()["id"] != pig.json()["id"]

    bob_pig = await client.get("/api/v1/pets/pig/relationship", headers=bob_headers)
    assert bob_pig.status_code == 200
    assert bob_pig.json()["id"] != pig.json()["id"]
