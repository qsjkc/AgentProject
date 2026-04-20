import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import get_current_user
from app.models.chat import ChatSession
from app.models.database import get_db
from app.models.user import User
from app.schemas.chat import ChatRequest, ChatResponse, ChatSessionResponse, StreamChunk
from app.services.chat import prepare_chat_turn, save_assistant_message, stream_response_chunks

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/stream")
async def chat_stream(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    async def generate():
        prepared_turn = await prepare_chat_turn(db, current_user, request)

        full_response = ""
        yield (
            "data: "
            + json.dumps(
                {
                    "content": "",
                    "done": False,
                    "session_id": prepared_turn.session.id,
                    "knowledge_used": bool(prepared_turn.rag_sources),
                    "sources": [source.model_dump() for source in prepared_turn.rag_sources],
                }
            )
            + "\n\n"
        )
        async for chunk in stream_response_chunks(prepared_turn.messages, stream=True):
            full_response += chunk
            yield f"data: {json.dumps(StreamChunk(content=chunk, done=False).model_dump())}\n\n"

        await save_assistant_message(db, prepared_turn.session, full_response)
        yield (
            "data: "
            + json.dumps(
                {
                    "content": "",
                    "done": True,
                    "session_id": prepared_turn.session.id,
                    "knowledge_used": bool(prepared_turn.rag_sources),
                    "sources": [source.model_dump() for source in prepared_turn.rag_sources],
                }
            )
            + "\n\n"
        )

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/message", response_model=ChatResponse)
async def chat_message(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prepared_turn = await prepare_chat_turn(db, current_user, request)

    full_response = ""
    async for chunk in stream_response_chunks(prepared_turn.messages, stream=False):
        full_response += chunk

    await save_assistant_message(db, prepared_turn.session, full_response)

    return ChatResponse(
        content=full_response,
        session_id=prepared_turn.session.id,
        knowledge_used=bool(prepared_turn.rag_sources),
        sources=prepared_turn.rag_sources,
    )


@router.get("/sessions", response_model=List[ChatSessionResponse])
async def get_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession)
        .options(selectinload(ChatSession.messages))
        .where(ChatSession.user_id == current_user.id)
        .order_by(ChatSession.updated_at.desc())
    )
    return result.scalars().all()


@router.get("/sessions/{session_id}", response_model=ChatSessionResponse)
async def get_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession)
        .options(selectinload(ChatSession.messages))
        .where(
            ChatSession.id == session_id,
            ChatSession.user_id == current_user.id,
        )
    )
    session = result.scalar_one_or_none()
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

    await db.delete(session)
    await db.commit()
    return {"message": "Session deleted"}
