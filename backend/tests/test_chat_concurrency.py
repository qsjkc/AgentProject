"""Chat requests must retain their original conversation and question.

The repository conftest selects temporary storage and blocks external services
before application imports. Models are replaced only by deterministic fakes.
"""
import asyncio
import json
from datetime import timedelta
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select, text
from sqlalchemy.util.concurrency import await_only

from app.api.v1 import chat as chat_api
from app.core.security import create_access_token
from app.main import app
from app.models.database import ChatMessage, PetIntimacyEvent, User, async_session_maker, engine
from app.services.chat import service as chat_service
from app.services.llm.service import llm_service
from app.services import pet_relationships


@pytest.fixture
async def chat_race_client():
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client


async def chat_headers():
    marker = uuid4().hex
    async with async_session_maker() as db:
        user = User(username="chat-race-" + marker, email=marker + "@example.com", hashed_password="unused")
        db.add(user)
        await db.commit()
        return {"Authorization": "Bearer " + create_access_token({"sub": str(user.id), "username": user.username})}


def stream_events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


@pytest.mark.parametrize("endpoint", ["message", "stream"])
@pytest.mark.parametrize("replacement_owner", ["original", "other"])
@pytest.mark.parametrize("pause_stage", ["before_question", "before_history", "model_pending"])
async def test_deleted_inflight_turn_does_not_write_to_reused_session(
    chat_race_client, monkeypatch, endpoint, replacement_owner, pause_stage,
):
    original_headers = await chat_headers()
    replacement_headers = original_headers if replacement_owner == "original" else await chat_headers()
    model_entered, release_model = asyncio.Event(), asyncio.Event()
    original_get_session = chat_service.get_or_create_session
    original_build_history = chat_service.build_history
    reward = AsyncMock(wraps=chat_api.reward_meaningful_chat)
    monkeypatch.setattr(chat_api, "reward_meaningful_chat", reward)

    async def paused_get_session(*args):
        session = await original_get_session(*args)
        if pause_stage == "before_question" and args[-1] == "original private question":
            model_entered.set()
            await release_model.wait()
        return session

    async def paused_build_history(*args, **kwargs):
        if pause_stage == "before_history" and kwargs["user_message"] == "original private question":
            model_entered.set()
            await release_model.wait()
        return await original_build_history(*args, **kwargs)

    async def fake_model(messages, **_kwargs):
        question = [message.content for message in messages if message.role == "user"][-1]
        if question == "original private question":
            assert pause_stage == "model_pending", "The deleted turn reached the model"
            model_entered.set()
            await release_model.wait()
            yield "original private answer"
        else:
            yield "replacement answer"

    monkeypatch.setattr(llm_service, "chat", fake_model)
    monkeypatch.setattr(chat_service, "get_or_create_session", paused_get_session)
    monkeypatch.setattr(chat_service, "build_history", paused_build_history)
    pending = asyncio.create_task(chat_race_client.post(
        f"/api/v1/chat/{endpoint}", headers=original_headers,
        json={"message": "original private question", "pet_type": "pig"},
    ))
    try:
        await asyncio.wait_for(model_entered.wait(), timeout=5)
        sessions = await chat_race_client.get("/api/v1/chat/sessions", headers=original_headers)
        original = sessions.json()[0]
        async with engine.connect() as connection:
            foreign_keys = (await connection.execute(text("PRAGMA foreign_keys"))).scalar_one()
        # Record the real connection mode; do not enable/disable it for the test.
        assert foreign_keys in (0, 1)
        print(f"SQLite foreign_keys={foreign_keys}, original session={original['id']}")
        deleted = await chat_race_client.delete(f"/api/v1/chat/sessions/{original['id']}", headers=original_headers)
        assert deleted.status_code == 200
        replacement = await chat_race_client.post(
            "/api/v1/chat/message", headers=replacement_headers,
            json={"message": "replacement question"},
        )
        assert replacement.status_code == 200
        # SQLite's normal INTEGER PRIMARY KEY reuses the deleted highest ID.
        assert replacement.json()["session_id"] == original["id"]
        expected_history = await chat_race_client.get(
            f"/api/v1/chat/sessions/{replacement.json()['session_id']}", headers=replacement_headers,
        )
        previous_reward_calls = reward.call_count
        release_model.set()
        original_result = await asyncio.wait_for(pending, timeout=5)
        replacement_history = await chat_race_client.get(
            f"/api/v1/chat/sessions/{replacement.json()['session_id']}", headers=replacement_headers,
        )
        assert replacement_history.json() == expected_history.json()
        assert reward.call_count == previous_reward_calls
        async with async_session_maker() as db:
            assert (await db.execute(select(ChatMessage.pet_type).where(
                ChatMessage.session_id == original["id"], ChatMessage.role == "user",
            ))).scalars().all() == [None]
        if endpoint == "message":
            assert original_result.status_code == 404
        else:
            assert stream_events(original_result)[-1]["error"] == "session_not_found"
    finally:
        release_model.set()
        if not pending.done():
            await asyncio.wait_for(pending, timeout=5)


@pytest.mark.parametrize("first_endpoint", ["message", "stream"])
@pytest.mark.parametrize("second_endpoint", ["message", "stream"])
async def test_concurrent_turns_do_not_replace_the_first_question(
    chat_race_client, monkeypatch, first_endpoint, second_endpoint,
):
    headers = await chat_headers()

    async def echo_last_question(messages, **_kwargs):
        yield "answer to: " + [message.content for message in messages if message.role == "user"][-1]

    monkeypatch.setattr(llm_service, "chat", echo_last_question)
    initial = await chat_race_client.post("/api/v1/chat/message", headers=headers, json={"message": "initial"})
    session_id = initial.json()["session_id"]
    first_history_entered, second_history_entered = asyncio.Event(), asyncio.Event()
    original_build_history = chat_service.build_history

    async def interleaved_history(*args, **kwargs):
        if kwargs["user_message"] == "first question":
            first_history_entered.set()
            await asyncio.wait_for(second_history_entered.wait(), timeout=5)
        elif kwargs["user_message"] == "second question":
            second_history_entered.set()
        return await original_build_history(*args, **kwargs)

    monkeypatch.setattr(chat_service, "build_history", interleaved_history)
    first = asyncio.create_task(chat_race_client.post(
        f"/api/v1/chat/{first_endpoint}", headers=headers,
        json={"message": "first question", "session_id": session_id},
    ))
    try:
        await asyncio.wait_for(first_history_entered.wait(), timeout=5)
        second = await chat_race_client.post(
            f"/api/v1/chat/{second_endpoint}", headers=headers,
            json={"message": "second question", "session_id": session_id},
        )
        first_result = await asyncio.wait_for(first, timeout=5)
        assert second.status_code == first_result.status_code == 200
        first_content = first_result.json()["content"] if first_endpoint == "message" else "".join(
            event["content"] for event in stream_events(first_result)
        )
        second_content = second.json()["content"] if second_endpoint == "message" else "".join(
            event["content"] for event in stream_events(second)
        )
        assert first_content == "answer to: first question"
        assert second_content == "answer to: second question"
    finally:
        second_history_entered.set()
        if not first.done():
            await asyncio.wait_for(first, timeout=5)


@pytest.mark.parametrize("endpoint", ["message", "stream"])
async def test_deleted_inflight_turn_returns_not_found_without_orphans(chat_race_client, monkeypatch, endpoint):
    headers = await chat_headers()
    model_entered, release_model = asyncio.Event(), asyncio.Event()
    reward = AsyncMock(wraps=chat_api.reward_meaningful_chat)
    monkeypatch.setattr(chat_api, "reward_meaningful_chat", reward)

    async def model(*_args, **_kwargs):
        model_entered.set()
        await release_model.wait()
        yield "discard this answer"

    monkeypatch.setattr(llm_service, "chat", model)
    pending = asyncio.create_task(chat_race_client.post(
        f"/api/v1/chat/{endpoint}", headers=headers, json={"message": "delete me", "pet_type": "pig"},
    ))
    try:
        await asyncio.wait_for(model_entered.wait(), timeout=5)
        sessions = await chat_race_client.get("/api/v1/chat/sessions", headers=headers)
        session_id = sessions.json()[0]["id"]
        response = await chat_race_client.delete(f"/api/v1/chat/sessions/{session_id}", headers=headers)
        assert response.status_code == 200
        release_model.set()
        response = await asyncio.wait_for(pending, timeout=5)
        if endpoint == "message":
            assert response.status_code == 404
        else:
            assert stream_events(response)[-1]["error"] == "session_not_found"
        reward.assert_not_called()
        async with async_session_maker() as db:
            assert (await db.execute(select(ChatMessage).where(ChatMessage.session_id == session_id))).all() == []
    finally:
        release_model.set()
        if not pending.done():
            await asyncio.wait_for(pending, timeout=5)


@pytest.mark.parametrize("endpoint", ["message", "stream"])
async def test_delete_waits_for_reply_commit_and_removes_its_messages(chat_race_client, monkeypatch, endpoint):
    headers = await chat_headers()
    reply_locked, delete_started, delete_locked, release_reply = (asyncio.Event() for _ in range(4))
    acquire_write = chat_service.acquire_session_write

    async def immediate_model(*_args, **_kwargs):
        yield "completed answer"

    async def pause_reply_write(db, identity, *, turn=None):
        await acquire_write(db, identity, turn=turn)
        if turn is not None:
            reply_locked.set()
            await release_reply.wait()

    async def observe_delete_lock(*args, **kwargs):
        delete_started.set()
        await acquire_write(*args, **kwargs)
        delete_locked.set()

    monkeypatch.setattr(llm_service, "chat", immediate_model)
    monkeypatch.setattr(chat_service, "acquire_session_write", pause_reply_write)
    monkeypatch.setattr(chat_api, "acquire_session_write", observe_delete_lock)
    pending = asyncio.create_task(chat_race_client.post(
        f"/api/v1/chat/{endpoint}", headers=headers, json={"message": "finish then delete"},
    ))
    deleting = None
    try:
        await asyncio.wait_for(reply_locked.wait(), timeout=5)
        sessions = await chat_race_client.get("/api/v1/chat/sessions", headers=headers)
        session_id = sessions.json()[0]["id"]
        deleting = asyncio.create_task(chat_race_client.delete(
            f"/api/v1/chat/sessions/{session_id}", headers=headers,
        ))
        await asyncio.wait_for(delete_started.wait(), timeout=5)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(delete_locked.wait(), timeout=0.1)
        release_reply.set()
        response, deleted = await asyncio.wait_for(asyncio.gather(pending, deleting), timeout=5)
        assert response.status_code == deleted.status_code == 200
        assert delete_locked.is_set()
        if endpoint == "message":
            assert response.json()["content"] == "completed answer"
        else:
            assert stream_events(response)[-1]["done"] is True
            assert all("error" not in event for event in stream_events(response))
        async with async_session_maker() as db:
            assert (await db.execute(select(ChatMessage).where(ChatMessage.session_id == session_id))).all() == []
    finally:
        release_reply.set()
        remaining = [task for task in (pending, deleting) if task is not None and not task.done()]
        if remaining:
            await asyncio.wait_for(asyncio.gather(*remaining), timeout=5)


@pytest.mark.parametrize("endpoint", ["detail", "list"])
@pytest.mark.parametrize("replacement_owner", ["original", "other"])
async def test_history_read_never_combines_old_owner_with_replacement_messages(
    chat_race_client, monkeypatch, endpoint, replacement_owner,
):
    headers = await chat_headers()
    replacement_headers = headers if replacement_owner == "original" else await chat_headers()

    async def model(messages, **_kwargs):
        yield "answer to: " + [message.content for message in messages if message.role == "user"][-1]

    monkeypatch.setattr(llm_service, "chat", model)
    created = await chat_race_client.post(
        "/api/v1/chat/message", headers=headers, json={"message": "original readable question"},
    )
    session_id = created.json()["session_id"]
    initial = await chat_race_client.get(f"/api/v1/chat/sessions/{session_id}", headers=headers)
    replaced = False

    async def replace_after_parent_query():
        deleted = await chat_race_client.delete(f"/api/v1/chat/sessions/{session_id}", headers=headers)
        assert deleted.status_code == 200
        replacement = await chat_race_client.post(
            "/api/v1/chat/message", headers=replacement_headers, json={"message": "replacement private question"},
        )
        assert replacement.status_code == 200
        assert replacement.json()["session_id"] == session_id

    def after_parent_query(_connection, _cursor, statement, _parameters, _context, _executemany):
        nonlocal replaced
        if not replaced and statement.lstrip().lower().startswith("select") and "from chat_sessions" in statement.lower():
            replaced = True
            # The async SQLite adapter has buffered this SELECT's rows. Replace
            # the session before ORM eager loading/response construction proceeds.
            await_only(replace_after_parent_query())

    event.listen(engine.sync_engine, "after_cursor_execute", after_parent_query)
    try:
        url = f"/api/v1/chat/sessions/{session_id}" if endpoint == "detail" else "/api/v1/chat/sessions"
        response = await chat_race_client.get(url, headers=headers)
    finally:
        event.remove(engine.sync_engine, "after_cursor_execute", after_parent_query)
    assert replaced
    assert response.status_code == 200
    snapshot = response.json() if endpoint == "detail" else response.json()[0]
    assert snapshot == initial.json()
    assert "replacement private" not in response.text


@pytest.mark.parametrize("endpoint", ["message", "stream"])
@pytest.mark.parametrize("legacy_key", [False, True])
async def test_reused_message_id_can_earn_reward_without_replaying_old_turn(
    chat_race_client, monkeypatch, endpoint, legacy_key,
):
    headers = await chat_headers()
    reward_time = chat_service.utc_now()
    monkeypatch.setattr(pet_relationships, "utc_now", lambda: reward_time)
    reward = AsyncMock(wraps=chat_api.reward_meaningful_chat)
    monkeypatch.setattr(chat_api, "reward_meaningful_chat", reward)

    async def model(*_args, **_kwargs):
        yield "a meaningful answer"

    monkeypatch.setattr(llm_service, "chat", model)
    first = await chat_race_client.post(
        "/api/v1/chat/message", headers=headers, json={"message": "first question", "pet_type": "pig"},
    )
    assert first.status_code == 200
    session_id = first.json()["session_id"]
    first_history = (await chat_race_client.get(f"/api/v1/chat/sessions/{session_id}", headers=headers)).json()
    message_id = first_history["messages"][0]["id"]
    user_id = first_history["user_id"]
    async with async_session_maker() as db:
        first_event = (await db.execute(select(PetIntimacyEvent).where(PetIntimacyEvent.user_id == user_id))).scalar_one()
        if legacy_key:
            # Preserve a record using the pre-upgrade key, without migration.
            first_event.idempotency_key = f"chat:{message_id}:meaningful_chat"
            await db.commit()
        previous_key = first_event.idempotency_key
    deleted = await chat_race_client.delete(f"/api/v1/chat/sessions/{session_id}", headers=headers)
    assert deleted.status_code == 200
    reward_time += timedelta(minutes=6)  # Past the real five-minute policy.
    second = await chat_race_client.post(
        f"/api/v1/chat/{endpoint}", headers=headers, json={"message": "new question", "pet_type": "pig"},
    )
    assert second.status_code == 200
    if endpoint == "message":
        assert second.json()["session_id"] == session_id
    else:
        assert stream_events(second)[-1]["session_id"] == session_id
    new_history = (await chat_race_client.get(f"/api/v1/chat/sessions/{session_id}", headers=headers)).json()
    assert new_history["messages"][0]["id"] == message_id
    async with async_session_maker() as db:
        events = (await db.execute(select(PetIntimacyEvent).where(PetIntimacyEvent.user_id == user_id))).scalars().all()
        assert len(events) == 2
        assert previous_key in {event.idempotency_key for event in events}
        assert sum(event.xp_awarded for event in events) == 4

    # Repeating the exact same completed turn must remain idempotent, even
    # after another cooldown period; the key must not depend on award time.
    replay_kwargs = reward.call_args.kwargs
    reward_time += timedelta(minutes=6)
    async with async_session_maker() as db:
        await chat_api.reward_meaningful_chat(db, **replay_kwargs)
        events = (await db.execute(select(PetIntimacyEvent).where(PetIntimacyEvent.user_id == user_id))).scalars().all()
        assert len(events) == 2
        assert sum(event.xp_awarded for event in events) == 4


@pytest.mark.parametrize("replacement_owner", ["original", "other"])
async def test_stream_handoff_keeps_the_prevalidated_session_identity(
    chat_race_client, monkeypatch, replacement_owner,
):
    headers = await chat_headers()
    replacement_headers = headers if replacement_owner == "original" else await chat_headers()
    prevalidated, release_stream = asyncio.Event(), asyncio.Event()
    find_session = chat_api.find_owned_session
    model_questions = []

    async def model(messages, **_kwargs):
        question = [message.content for message in messages if message.role == "user"][-1]
        model_questions.append(question)
        yield "answer to: " + question

    async def paused_prevalidation(*args):
        session = await find_session(*args)
        prevalidated.set()
        await release_stream.wait()
        return session

    monkeypatch.setattr(llm_service, "chat", model)
    initial = await chat_race_client.post(
        "/api/v1/chat/message", headers=headers, json={"message": "initial question"},
    )
    session_id = initial.json()["session_id"]
    monkeypatch.setattr(chat_api, "find_owned_session", paused_prevalidation)
    pending = asyncio.create_task(chat_race_client.post(
        "/api/v1/chat/stream", headers=headers,
        json={"message": "late original question", "session_id": session_id, "pet_type": "pig"},
    ))
    try:
        await asyncio.wait_for(prevalidated.wait(), timeout=5)
        deleted = await chat_race_client.delete(f"/api/v1/chat/sessions/{session_id}", headers=headers)
        assert deleted.status_code == 200
        replacement = await chat_race_client.post(
            "/api/v1/chat/message", headers=replacement_headers, json={"message": "replacement question"},
        )
        assert replacement.status_code == 200
        assert replacement.json()["session_id"] == session_id
        expected = await chat_race_client.get(f"/api/v1/chat/sessions/{session_id}", headers=replacement_headers)
        release_stream.set()
        response = await asyncio.wait_for(pending, timeout=5)
        actual = await chat_race_client.get(f"/api/v1/chat/sessions/{session_id}", headers=replacement_headers)
        assert actual.json() == expected.json()
        assert stream_events(response)[-1]["error"] == "session_not_found"
        assert model_questions == ["initial question", "replacement question"]
    finally:
        release_stream.set()
        if not pending.done():
            await asyncio.wait_for(pending, timeout=5)
