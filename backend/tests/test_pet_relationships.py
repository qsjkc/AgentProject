import os
import shutil
from datetime import datetime, timedelta
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
    award_pet_relationship,
    get_pet_daily_summary,
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
    assert pig.json()["outfit"] == {
        "unlocked_outfit_ids": ["pig_basic_scarf"],
        "equipped_outfits": {},
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

    daily_summary = await client.get("/api/v1/pets/pig/daily-summary", headers=bob_headers)
    assert daily_summary.status_code == 200
    assert daily_summary.json()["pet_type"] == "pig"
    assert daily_summary.json()["interaction_count"] == 0
    assert daily_summary.json()["xp_gained"] == 0
    assert daily_summary.json()["reminders_created_count"] == 0
    assert daily_summary.json()["reminders_completed_count"] == 0


@pytest.mark.asyncio
async def test_daily_summary_uses_local_day_and_isolates_user_and_pet(client: AsyncClient):
    alice_headers = await register_and_login(client, "daily-alice", "daily-alice@example.com")
    bob_headers = await register_and_login(client, "daily-bob", "daily-bob@example.com")

    alice_relationship = await client.get("/api/v1/pets/pig/relationship", headers=alice_headers)
    bob_relationship = await client.get("/api/v1/pets/pig/relationship", headers=bob_headers)
    alice_user_id = alice_relationship.json()["user_id"]
    bob_user_id = bob_relationship.json()["user_id"]

    from app.models.database import (  # noqa: E402
        ChatMessage,
        ChatSession,
        Reminder,
        async_session_maker,
    )

    summary_time = datetime(2026, 7, 31, 7, 0, 0)
    async with async_session_maker() as session:
        for index, action in enumerate(
            ("pat", "meaningful_chat", "reminder_created", "reminder_completed")
        ):
            result = await award_pet_relationship(
                session,
                user_id=alice_user_id,
                pet_type="pig",
                action=action,
                idempotency_key=f"daily-summary-{action}",
                now=summary_time + timedelta(minutes=index),
            )
            assert result["reason"] == "awarded"

        alice_chat_session = ChatSession(user_id=alice_user_id, title="Alice daily chat")
        bob_chat_session = ChatSession(user_id=bob_user_id, title="Bob daily chat")
        session.add_all([alice_chat_session, bob_chat_session])
        await session.flush()

        session.add_all(
            [
                Reminder(
                    user_id=alice_user_id,
                    pet_type="pig",
                    title="Today reminder",
                    remind_at=summary_time + timedelta(hours=2),
                    status="completed",
                    completed_at=summary_time + timedelta(minutes=5),
                    created_at=summary_time,
                ),
                Reminder(
                    user_id=alice_user_id,
                    pet_type="pig",
                    title="Older reminder",
                    remind_at=summary_time,
                    status="completed",
                    completed_at=summary_time + timedelta(minutes=6),
                    created_at=summary_time - timedelta(days=1),
                ),
                Reminder(
                    user_id=alice_user_id,
                    pet_type="cat",
                    title="Other pet reminder",
                    remind_at=summary_time,
                    status="completed",
                    completed_at=summary_time,
                    created_at=summary_time,
                ),
                Reminder(
                    user_id=bob_user_id,
                    pet_type="pig",
                    title="Other user reminder",
                    remind_at=summary_time,
                    status="completed",
                    completed_at=summary_time,
                    created_at=summary_time,
                ),
                ChatMessage(
                    session_id=alice_chat_session.id,
                    role="user",
                    pet_type="pig",
                    content="First pig chat",
                    created_at=summary_time + timedelta(minutes=1),
                ),
                ChatMessage(
                    session_id=alice_chat_session.id,
                    role="user",
                    pet_type="pig",
                    content="Second pig chat",
                    created_at=summary_time + timedelta(minutes=4),
                ),
                ChatMessage(
                    session_id=alice_chat_session.id,
                    role="user",
                    pet_type="cat",
                    content="Other pet chat",
                    created_at=summary_time,
                ),
                ChatMessage(
                    session_id=bob_chat_session.id,
                    role="user",
                    pet_type="pig",
                    content="Other user chat",
                    created_at=summary_time,
                ),
            ]
        )
        await session.commit()

        summary = await get_pet_daily_summary(
            session,
            user_id=alice_user_id,
            pet_type="pig",
            now=summary_time,
        )

    assert summary["local_date"].isoformat() == "2026-07-31"
    assert summary["timezone"] == "Asia/Shanghai"
    assert summary["interaction_count"] == 6
    assert summary["xp_gained"] == 19
    assert summary["action_counts"] == {
        "meaningful_chat": 2,
        "pat": 1,
        "reminder_completed": 2,
        "reminder_created": 1,
    }
    assert summary["care_count"] == 1
    assert summary["meaningful_chat_count"] == 2
    assert summary["reminders_created_count"] == 1
    assert summary["reminders_completed_count"] == 2
    assert summary["first_interaction_at"] == summary_time
    assert summary["last_interaction_at"] == summary_time + timedelta(minutes=6)


@pytest.mark.asyncio
async def test_max_level_activity_is_remembered_without_more_xp(client: AsyncClient):
    headers = await register_and_login(client, "max-memory", "max-memory@example.com")
    relationship_response = await client.get("/api/v1/pets/pig/relationship", headers=headers)
    user_id = relationship_response.json()["user_id"]

    from sqlalchemy import select  # noqa: E402
    from app.models.database import (  # noqa: E402
        PetActivityEvent,
        PetRelationship,
        async_session_maker,
    )

    first_pat_at = datetime(2026, 8, 1, 2, 0, 0)
    async with async_session_maker() as session:
        relationship_result = await session.execute(
            select(PetRelationship).where(
                PetRelationship.user_id == user_id,
                PetRelationship.pet_type == "pig",
            )
        )
        relationship = relationship_result.scalar_one()
        relationship.intimacy_xp = 900
        relationship.level = 5
        relationship.relationship_stage = "deep_bond"
        await session.commit()

        first = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="pat",
            idempotency_key="max-level-pat-0",
            now=first_pat_at,
        )
        assert first["reason"] == "max_level"
        assert first["awarded_xp"] == 0

        duplicate = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="pat",
            idempotency_key="max-level-pat-0",
            now=first_pat_at + timedelta(seconds=1),
        )
        assert duplicate["reason"] == "duplicate"

        cooling_down = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="pat",
            idempotency_key="max-level-pat-cooldown",
            now=first_pat_at + timedelta(minutes=1),
        )
        assert cooling_down["reason"] == "cooldown"

        for index in range(1, 10):
            max_level_result = await award_pet_relationship(
                session,
                user_id=user_id,
                pet_type="pig",
                action="pat",
                idempotency_key=f"max-level-pat-{index}",
                now=first_pat_at + timedelta(minutes=index * 5),
            )
            assert max_level_result["reason"] == "max_level"
            assert max_level_result["awarded_xp"] == 0

        beyond_daily_limit = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="pat",
            idempotency_key="max-level-pat-10",
            now=first_pat_at + timedelta(minutes=50),
        )
        assert beyond_daily_limit["reason"] == "max_level"

        summary = await get_pet_daily_summary(
            session,
            user_id=user_id,
            pet_type="pig",
            now=first_pat_at,
        )
        activity_result = await session.execute(
            select(PetActivityEvent).where(
                PetActivityEvent.user_id == user_id,
                PetActivityEvent.pet_type == "pig",
                PetActivityEvent.action == "pat",
            )
        )
        activities = activity_result.scalars().all()

    assert len(activities) == 10
    assert summary["interaction_count"] == 10
    assert summary["care_count"] == 10
    assert summary["action_counts"] == {"pat": 10}
    assert summary["xp_gained"] == 0
    assert summary["last_interaction_at"] == first_pat_at + timedelta(minutes=45)


@pytest.mark.asyncio
async def test_activity_survives_daily_xp_cap(client: AsyncClient):
    headers = await register_and_login(client, "daily-cap-memory", "daily-cap-memory@example.com")
    relationship_response = await client.get("/api/v1/pets/pig/relationship", headers=headers)
    user_id = relationship_response.json()["user_id"]

    from sqlalchemy import select  # noqa: E402
    from app.models.database import (  # noqa: E402
        PetIntimacyEvent,
        PetRelationship,
        async_session_maker,
    )

    interaction_at = datetime(2026, 8, 2, 2, 0, 0)
    async with async_session_maker() as session:
        relationship_result = await session.execute(
            select(PetRelationship).where(
                PetRelationship.user_id == user_id,
                PetRelationship.pet_type == "pig",
            )
        )
        relationship = relationship_result.scalar_one()
        relationship.intimacy_xp = 120
        relationship.level = 2
        relationship.relationship_stage = "getting_familiar"
        session.add(
            PetIntimacyEvent(
                user_id=user_id,
                relationship_id=relationship.id,
                pet_type="pig",
                action="reminder_completed",
                xp_awarded=120,
                idempotency_key="daily-cap-seed",
                awarded_at=interaction_at,
            )
        )
        await session.commit()

        capped = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="feed",
            idempotency_key="daily-cap-feed",
            now=interaction_at + timedelta(minutes=1),
        )
        summary = await get_pet_daily_summary(
            session,
            user_id=user_id,
            pet_type="pig",
            now=interaction_at,
        )

    assert capped["reason"] == "daily_cap"
    assert capped["awarded_xp"] == 0
    assert capped["relationship"]["intimacy_xp"] == 120
    assert summary["interaction_count"] == 1
    assert summary["care_count"] == 1
    assert summary["action_counts"] == {"feed": 1}
    assert summary["xp_gained"] == 120


@pytest.mark.asyncio
async def test_activity_backfill_is_idempotent(client: AsyncClient):
    headers = await register_and_login(client, "activity-backfill", "activity-backfill@example.com")
    relationship_response = await client.get("/api/v1/pets/pig/relationship", headers=headers)
    user_id = relationship_response.json()["user_id"]
    relationship_id = relationship_response.json()["id"]

    from sqlalchemy import func, select  # noqa: E402
    from app.models.database import (  # noqa: E402
        PetActivityEvent,
        PetIntimacyEvent,
        async_session_maker,
        backfill_pet_activity_events,
        engine,
    )

    occurred_at = datetime(2026, 8, 3, 2, 0, 0)
    async with async_session_maker() as session:
        session.add(
            PetIntimacyEvent(
                user_id=user_id,
                relationship_id=relationship_id,
                pet_type="pig",
                action="clean",
                xp_awarded=4,
                idempotency_key="legacy-clean-event",
                awarded_at=occurred_at,
            )
        )
        await session.commit()

    async with engine.begin() as connection:
        await backfill_pet_activity_events(connection)
        await backfill_pet_activity_events(connection)

    async with async_session_maker() as session:
        count_result = await session.execute(
            select(func.count(PetActivityEvent.id)).where(
                PetActivityEvent.user_id == user_id,
                PetActivityEvent.idempotency_key == "legacy-clean-event",
            )
        )
        activity_count = count_result.scalar_one()
        activity_result = await session.execute(
            select(PetActivityEvent).where(
                PetActivityEvent.user_id == user_id,
                PetActivityEvent.idempotency_key == "legacy-clean-event",
            )
        )
        activity = activity_result.scalar_one()

    assert activity_count == 1
    assert activity.action == "clean"
    assert activity.occurred_at == occurred_at


@pytest.mark.asyncio
async def test_outfit_api_enforces_slot_and_unlock_level(client: AsyncClient):
    headers = await register_and_login(client, "outfit-api", "outfit-api@example.com")

    equipped = await client.put(
        "/api/v1/pets/pig/relationship/outfit",
        headers=headers,
        json={"slot": "neck", "item_id": "pig_basic_scarf"},
    )
    assert equipped.status_code == 200
    assert equipped.json()["outfit"]["equipped_outfits"] == {
        "neck": "pig_basic_scarf",
    }

    locked = await client.put(
        "/api/v1/pets/pig/relationship/outfit",
        headers=headers,
        json={"slot": "head", "item_id": "pig_sleep_cap"},
    )
    assert locked.status_code == 409
    assert locked.json()["detail"] == "outfit_locked"

    wrong_slot = await client.put(
        "/api/v1/pets/pig/relationship/outfit",
        headers=headers,
        json={"slot": "head", "item_id": "pig_basic_scarf"},
    )
    assert wrong_slot.status_code == 422
    assert wrong_slot.json()["detail"] == "outfit_slot_mismatch"

    cleared = await client.put(
        "/api/v1/pets/pig/relationship/outfit",
        headers=headers,
        json={"slot": "neck", "item_id": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["outfit"]["equipped_outfits"] == {}


@pytest.mark.asyncio
async def test_reward_api_enforces_idempotency_and_cooldown(client: AsyncClient):
    headers = await register_and_login(client, "reward-api", "reward-api@example.com")

    awarded = await client.post(
        "/api/v1/pets/pig/relationship/rewards",
        headers=headers,
        json={"action": "poke", "idempotency_key": "poke-1"},
    )
    assert awarded.status_code == 200
    assert awarded.json()["reason"] == "awarded"
    assert awarded.json()["awarded_xp"] == 1
    assert awarded.json()["relationship"]["intimacy_xp"] == 1

    duplicate = await client.post(
        "/api/v1/pets/pig/relationship/rewards",
        headers=headers,
        json={"action": "poke", "idempotency_key": "poke-1"},
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["reason"] == "duplicate"
    assert duplicate.json()["awarded_xp"] == 0
    assert duplicate.json()["relationship"]["intimacy_xp"] == 1

    cooling_down = await client.post(
        "/api/v1/pets/pig/relationship/rewards",
        headers=headers,
        json={"action": "poke", "idempotency_key": "poke-2"},
    )
    assert cooling_down.status_code == 200
    assert cooling_down.json()["reason"] == "cooldown"
    assert cooling_down.json()["cooldown_remaining_seconds"] > 0

    invalid_action = await client.post(
        "/api/v1/pets/pig/relationship/rewards",
        headers=headers,
        json={"action": "unknown", "idempotency_key": "bad-action"},
    )
    assert invalid_action.status_code == 422


@pytest.mark.asyncio
async def test_reward_policy_caps_daily_action_and_levels_up(client: AsyncClient):
    headers = await register_and_login(client, "reward-policy", "reward-policy@example.com")
    relationship_response = await client.get("/api/v1/pets/pig/relationship", headers=headers)
    assert relationship_response.status_code == 200
    user_id = relationship_response.json()["user_id"]

    from app.models.database import async_session_maker  # noqa: E402

    first_day = datetime(2026, 7, 28, 1, 0, 0)
    async with async_session_maker() as session:
        for index in range(5):
            result = await award_pet_relationship(
                session,
                user_id=user_id,
                pet_type="pig",
                action="reminder_completed",
                idempotency_key=f"day-one-{index}",
                now=first_day + timedelta(seconds=index),
            )
            assert result["reason"] == "awarded"

        capped = await award_pet_relationship(
            session,
            user_id=user_id,
            pet_type="pig",
            action="reminder_completed",
            idempotency_key="day-one-capped",
            now=first_day + timedelta(minutes=1),
        )
        assert capped["reason"] == "action_daily_cap"
        assert capped["relationship"]["intimacy_xp"] == 50

        second_day = first_day + timedelta(days=1)
        final_result = None
        for index in range(5):
            final_result = await award_pet_relationship(
                session,
                user_id=user_id,
                pet_type="pig",
                action="reminder_completed",
                idempotency_key=f"day-two-{index}",
                now=second_day + timedelta(seconds=index),
            )

    assert final_result is not None
    assert final_result["relationship"]["intimacy_xp"] == 100
    assert final_result["relationship"]["level"] == 2
    assert final_result["relationship"]["relationship_stage"] == "getting_familiar"
    assert final_result["relationship"]["progress"] == {
        "current": 0,
        "required": 160,
        "percent": 0.0,
    }
    assert final_result["relationship"]["outfit"]["unlocked_outfit_ids"] == [
        "pig_basic_scarf",
        "pig_sleep_cap",
    ]
    assert final_result["level_up"] is True

    third_day = first_day + timedelta(days=2)
    async with async_session_maker() as session:
        for action, count, spacing_minutes in (
            ("reminder_completed", 5, 1),
            ("meaningful_chat", 10, 5),
            ("pat", 10, 5),
            ("feed", 4, 30),
        ):
            for index in range(count):
                result = await award_pet_relationship(
                    session,
                    user_id=user_id,
                    pet_type="pig",
                    action=action,
                    idempotency_key=f"day-three-{action}-{index}",
                    now=third_day + timedelta(minutes=index * spacing_minutes),
                )
                assert result["reason"] == "awarded"

    assert result["relationship"]["intimacy_xp"] == 220
    assert result["relationship"]["level"] == 2

    fourth_day = first_day + timedelta(days=3)
    async with async_session_maker() as session:
        for index in range(4):
            level_three_result = await award_pet_relationship(
                session,
                user_id=user_id,
                pet_type="pig",
                action="reminder_completed",
                idempotency_key=f"day-four-{index}",
                now=fourth_day + timedelta(seconds=index),
            )

    assert level_three_result["relationship"]["intimacy_xp"] == 260
    assert level_three_result["relationship"]["level"] == 3
    assert level_three_result["relationship"]["relationship_stage"] == "clingy"
    assert level_three_result["relationship"]["outfit"]["unlocked_outfit_ids"] == [
        "pig_basic_scarf",
        "pig_sleep_cap",
        "pig_bell",
    ]
    assert level_three_result["level_up"] is True
