from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utc_now
from app.models.chat import ChatMessage, ChatSession
from app.models.user import User
from app.schemas.chat import ChatRequest
from app.services.llm.base import Message
from app.services.llm.service import llm_service
from app.services.rag import rag_service

PROVIDER_UNAVAILABLE_MESSAGE = (
    "LLM provider is currently unavailable. "
    "Please retry later or verify the model service configuration."
)

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


@dataclass
class PreparedChatTurn:
    session: ChatSession
    messages: list[Message]
    rag_sources: list


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
) -> tuple[list[Message], list]:
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


async def prepare_chat_turn(
    db: AsyncSession,
    current_user: User,
    request: ChatRequest,
) -> PreparedChatTurn:
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
    return PreparedChatTurn(session=session, messages=messages, rag_sources=rag_sources)


async def save_assistant_message(db: AsyncSession, session: ChatSession, content: str) -> None:
    db.add(
        ChatMessage(
            session_id=session.id,
            role="assistant",
            content=content,
        )
    )
    session.updated_at = utc_now()
    await db.commit()


async def stream_response_chunks(messages: list[Message], *, stream: bool) -> AsyncIterator[str]:
    try:
        async for chunk in llm_service.chat(messages, stream=stream):
            yield chunk
    except Exception:
        yield PROVIDER_UNAVAILABLE_MESSAGE
