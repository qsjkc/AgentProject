import json
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import contains_eager, noload
from starlette.background import BackgroundTask

from app.core.logging import logger
from app.core.security import get_current_user
from app.models.chat import ChatMessage, ChatSession
from app.models.database import async_session_maker, get_db
from app.models.user import User
from app.schemas.chat import ChatRequest, ChatResponse, ChatSessionResponse, StreamChunk
from app.services.chat import prepare_chat_turn, save_assistant_message, stream_response_chunks
from app.services.chat.service import (
    ChatProviderUnavailable, ChatSessionIdentity, ChatSessionNotFound,
    acquire_session_write, find_owned_session,
)
from app.services.pet_relationships import award_pet_relationship

router = APIRouter(prefix="/chat", tags=["chat"])


async def reward_meaningful_chat(
    db: AsyncSession,
    *,
    user_id: int,
    pet_type: str | None,
    user_message_id: int,
    user_message_created_at: datetime,
) -> None:
    if not pet_type:
        return
    try:
        await award_pet_relationship(
            db,
            user_id=user_id,
            pet_type=pet_type,
            action="meaningful_chat",
            # Deleted SQLite message IDs can be reused by a different turn.
            # Keep retries stable without colliding with that later message.
            idempotency_key=f"chat:{user_message_id}:{user_message_created_at.isoformat(timespec='microseconds')}:meaningful_chat",
        )
    except Exception:
        logger.exception(
            "Failed to award chat intimacy user_id=%s message_id=%s pet_type=%s",
            user_id,
            user_message_id,
            pet_type,
        )


@router.post("/stream")
async def chat_stream(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    # Report a stale or foreign selection before opening an SSE response. The
    # generator checks ownership again, including deletion during hand-off.
    expected_session = None
    if request.session_id is not None:
        async with async_session_maker() as validation_db:
            try:
                session = await find_owned_session(validation_db, current_user.id, request.session_id)
                expected_session = ChatSessionIdentity.from_session(session)
            except ChatSessionNotFound as error:
                raise HTTPException(status_code=404, detail=str(error)) from error

    async def generate():
        # The response body outlives FastAPI's request dependency scope. Own the
        # session here so completion and interrupted streams both return it.
        async with async_session_maker() as db:
            try:
                prepared_turn = await prepare_chat_turn(
                    db, current_user, request, expected_session=expected_session,
                )
            except ChatSessionNotFound as error:
                yield f"data: {json.dumps({'content': '', 'done': True, 'error': 'session_not_found', 'message': str(error)})}\n\n"
                return

            full_response = ""
            yield (
                "data: "
                + json.dumps(
                    {
                        "content": "",
                        "done": False,
                        "session_id": prepared_turn.identity.session.id,
                        "knowledge_used": bool(prepared_turn.rag_sources),
                        "sources": [source.model_dump() for source in prepared_turn.rag_sources],
                    }
                )
                + "\n\n"
            )
            try:
                async for chunk in stream_response_chunks(prepared_turn.messages, stream=True):
                    full_response += chunk
                    yield f"data: {json.dumps(StreamChunk(content=chunk, done=False).model_dump())}\n\n"
            except ChatProviderUnavailable as error:
                # Partial provider text is provisional. A failed turn must not
                # become persisted assistant history or relationship rewards.
                yield f"data: {json.dumps({'content': '', 'done': True, 'session_id': prepared_turn.identity.session.id, 'error': 'provider_unavailable', 'message': str(error)})}\n\n"
                return

            try:
                await save_assistant_message(db, prepared_turn, full_response, pet_type=request.pet_type)
            except ChatSessionNotFound as error:
                yield f"data: {json.dumps({'content': '', 'done': True, 'session_id': prepared_turn.identity.session.id, 'error': 'session_not_found', 'message': str(error)})}\n\n"
                return
            await reward_meaningful_chat(
                db,
                user_id=current_user.id,
                pet_type=request.pet_type,
                user_message_id=prepared_turn.user_message_id,
                user_message_created_at=prepared_turn.identity.message_created_at,
            )
            yield (
                "data: "
                + json.dumps(
                    {
                        "content": "",
                        "done": True,
                        "session_id": prepared_turn.identity.session.id,
                        "knowledge_used": bool(prepared_turn.rag_sources),
                        "sources": [source.model_dump() for source in prepared_turn.rag_sources],
                    }
                )
                + "\n\n"
            )

    body = generate()

    async def close_body():
        await body.aclose()

    return StreamingResponse(
        body,
        media_type="text/event-stream",
        # Disconnecting while Starlette is sending a yielded chunk leaves the
        # generator suspended; close it after the response task group exits.
        background=BackgroundTask(close_body),
    )


@router.post("/message", response_model=ChatResponse)
async def chat_message(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        prepared_turn = await prepare_chat_turn(db, current_user, request)
    except ChatSessionNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    full_response = ""
    try:
        async for chunk in stream_response_chunks(prepared_turn.messages, stream=False):
            full_response += chunk
    except ChatProviderUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    try:
        await save_assistant_message(db, prepared_turn, full_response, pet_type=request.pet_type)
    except ChatSessionNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await reward_meaningful_chat(
        db,
        user_id=current_user.id,
        pet_type=request.pet_type,
        user_message_id=prepared_turn.user_message_id,
        user_message_created_at=prepared_turn.identity.message_created_at,
    )

    return ChatResponse(
        content=full_response,
        session_id=prepared_turn.identity.session.id,
        knowledge_used=bool(prepared_turn.rag_sources),
        sources=prepared_turn.rag_sources,
    )


@router.get("/sessions", response_model=List[ChatSessionResponse])
async def get_sessions(
    include_messages: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(ChatSession)
        .where(ChatSession.user_id == current_user.id)
        .order_by(ChatSession.updated_at.desc(), ChatSession.id.desc())
    )
    if include_messages:
        # Ownership and child rows must come from one statement snapshot. A
        # second SELECT by bare session ID could observe a deleted ID's reuse.
        query = query.outerjoin(ChatSession.messages).options(
            contains_eager(ChatSession.messages)
        ).order_by(ChatMessage.id.asc())
    else:
        query = query.options(noload(ChatSession.messages))
    result = await db.execute(query)
    return result.unique().scalars().all()


@router.get("/sessions/{session_id}", response_model=ChatSessionResponse)
async def get_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession)
        .outerjoin(ChatSession.messages)
        .options(contains_eager(ChatSession.messages))
        .where(
            ChatSession.id == session_id,
            ChatSession.user_id == current_user.id,
        )
        .order_by(ChatMessage.id.asc())
    )
    session = result.unique().scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.id == session_id,
            ChatSession.user_id == current_user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Lock before loading the cascade's message list. A finishing turn either
    # commits first and is included, or sees the deletion and rejects its write.
    try:
        await acquire_session_write(db, ChatSessionIdentity.from_session(session))
    except ChatSessionNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await db.delete(session)
    await db.commit()
    return {"message": "Session deleted"}
