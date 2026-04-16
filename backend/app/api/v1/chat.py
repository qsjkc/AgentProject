import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import get_current_user
from app.core.time import utc_now
from app.models.chat import ChatMessage, ChatSession
from app.models.database import get_db
from app.models.user import User
from app.schemas.chat import ChatRequest, ChatResponse, ChatSessionResponse, StreamChunk
from app.services.llm.base import Message
from app.services.llm.service import llm_service
from app.services.rag import rag_service

router = APIRouter(prefix="/chat", tags=["chat"])

PET_PERSONA_PROMPTS = {
    "cat": (
        "You are speaking as a desktop cat companion. "
        "Be concise, sharp, agile, slightly proud, and emotionally perceptive. "
        "Keep the tone clean and direct, without sounding cold."
    ),
    "dog": (
        "You are speaking as a desktop dog companion. "
        "Be warm, upbeat, loyal, and proactive. "
        "Sound encouraging and companionable, while staying efficient."
    ),
    "pig": (
        "You are speaking as a desktop pig companion. "
        "Be gentle, relaxed, healing, and lightly playful. "
        "Keep the rhythm soft and reassuring without becoming vague."
    ),
}


async def get_or_create_session(
    db: AsyncSession,
    current_user: User,
    session_id: int | None,
    message: str,
) -> ChatSession:
    session = None
    if session_id:
        result = await db.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.user_id == current_user.id,
            )
        )
        session = result.scalar_one_or_none()

    if not session:
        session = ChatSession(
            user_id=current_user.id,
            title=message[:50] + ("..." if len(message) > 50 else ""),
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
    return session


async def build_history(
    db: AsyncSession,
    session: ChatSession,
    *,
    user_id: int,
    user_message: str,
    use_rag: bool,
    pet_type: str | None,
    compact_response: bool,
) -> tuple[List[Message], list]:
    result = await db.execute(
        select(ChatMessage).where(ChatMessage.session_id == session.id).order_by(ChatMessage.created_at.asc())
    )
    history = result.scalars().all()
    messages: list[Message] = []
    rag_sources = []

    persona_prompt = PET_PERSONA_PROMPTS.get(pet_type or "")
    if persona_prompt:
        messages.append(Message(role="system", content=persona_prompt))

    if use_rag:
        rag_context = rag_service.build_context(user_id=user_id, question=user_message)
        rag_sources = rag_context.sources
        if rag_context.context:
            messages.append(
                Message(
                    role="system",
                    content=(
                        "Use the following knowledge base context when it is relevant. "
                        "If the context is insufficient, say so explicitly.\n\n"
                        f"{rag_context.context}"
                    ),
                ),
            )

    if compact_response:
        messages.append(
            Message(
                role="system",
                content=(
                    "You are replying inside a small desktop pet bubble. "
                    "Keep the answer concise, natural, and immediately useful. "
                    "Use at most 2 to 3 short Chinese lines or roughly 80 Chinese characters "
                    "unless the user explicitly asks for a detailed explanation."
                ),
            )
        )

    messages.extend(Message(role=item.role, content=item.content) for item in history)
    return messages, rag_sources


@router.post("/stream")
async def chat_stream(
    request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    async def generate():
        session = await get_or_create_session(db, current_user, request.session_id, request.message)

        db.add(
            ChatMessage(
                session_id=session.id,
                role="user",
                content=request.message,
            )
        )
        session.updated_at = utc_now()
        await db.commit()

        messages, rag_sources = await build_history(
            db,
            session,
            user_id=current_user.id,
            user_message=request.message,
            use_rag=request.use_rag,
            pet_type=request.pet_type,
            compact_response=request.compact_response,
        )

        full_response = ""
        yield (
            "data: "
            + json.dumps(
                {
                    "content": "",
                    "done": False,
                    "session_id": session.id,
                    "knowledge_used": bool(rag_sources),
                    "sources": [source.model_dump() for source in rag_sources],
                }
            )
            + "\n\n"
        )
        try:
            async for chunk in llm_service.chat(messages, stream=True):
                full_response += chunk
                yield f"data: {json.dumps(StreamChunk(content=chunk, done=False).model_dump())}\n\n"
        except Exception:
            full_response = (
                "LLM provider is currently unavailable. "
                "Please retry later or verify the model service configuration."
            )
            yield f"data: {json.dumps({'content': full_response, 'done': False, 'session_id': session.id})}\n\n"

        db.add(
            ChatMessage(
                session_id=session.id,
                role="assistant",
                content=full_response,
            )
        )
        session.updated_at = utc_now()
        await db.commit()
        yield (
            "data: "
            + json.dumps(
                {
                    "content": "",
                    "done": True,
                    "session_id": session.id,
                    "knowledge_used": bool(rag_sources),
                    "sources": [source.model_dump() for source in rag_sources],
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
    session = await get_or_create_session(db, current_user, request.session_id, request.message)

    db.add(
        ChatMessage(
            session_id=session.id,
            role="user",
            content=request.message,
        )
    )
    session.updated_at = utc_now()
    await db.commit()

    messages, rag_sources = await build_history(
        db,
        session,
        user_id=current_user.id,
        user_message=request.message,
        use_rag=request.use_rag,
        pet_type=request.pet_type,
        compact_response=request.compact_response,
    )

    full_response = ""
    try:
        async for chunk in llm_service.chat(messages, stream=False):
            full_response += chunk
    except Exception:
        full_response = (
            "LLM provider is currently unavailable. "
            "Please retry later or verify the model service configuration."
        )

    db.add(
        ChatMessage(
            session_id=session.id,
            role="assistant",
            content=full_response,
        )
    )
    session.updated_at = utc_now()
    await db.commit()

    return ChatResponse(
        content=full_response,
        session_id=session.id,
        knowledge_used=bool(rag_sources),
        sources=rag_sources,
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
