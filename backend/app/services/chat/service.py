from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import AsyncIterator

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.time import utc_now
from app.models.chat import ChatMessage, ChatSession
from app.models.user import User
from app.schemas.chat import ChatRequest
from app.services.llm.base import Message
from app.services.llm.service import llm_service
from app.services.rag import rag_service
from app.services.rag.prompts import knowledge_context_messages

PROVIDER_UNAVAILABLE_MESSAGE = "暂时无法生成回答，请稍后重试。"


class ChatProviderUnavailable(Exception):
    """The provider failed to produce a complete usable response."""


class ChatSessionNotFound(Exception):
    """An explicitly selected conversation is no longer available to its owner."""


async def find_owned_session(db: AsyncSession, user_id: int, session_id: int) -> ChatSession:
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id, ChatSession.user_id == user_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise ChatSessionNotFound("这段对话已不可用，请打开其他对话或开始新对话。")
    return session

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
    user_message_id: int
    messages: list[Message]
    rag_sources: list
    identity: ChatTurnIdentity


@dataclass(frozen=True)
class ChatSessionIdentity:
    id: int
    user_id: int
    created_at: datetime

    @classmethod
    def from_session(cls, session: ChatSession) -> ChatSessionIdentity:
        return cls(session.id, session.user_id, session.created_at)


@dataclass(frozen=True)
class ChatTurnIdentity:
    session: ChatSessionIdentity
    message_id: int
    message_created_at: datetime
    message_content: str


async def acquire_session_write(
    db: AsyncSession,
    identity: ChatSessionIdentity,
    *,
    turn: ChatTurnIdentity | None = None,
) -> None:
    """Validate and lock the original row in the same short write transaction.

    SQLite can reuse deleted integer IDs, so IDs alone cannot identify a turn.
    The conditional UPDATE also serializes deletion with message persistence;
    there is no unchecked gap between a SELECT and the subsequent write.
    """
    conditions = [
        ChatSession.id == identity.id,
        ChatSession.user_id == identity.user_id,
        ChatSession.created_at == identity.created_at,
    ]
    if turn is not None:
        conditions.append(select(ChatMessage.id).where(
            ChatMessage.id == turn.message_id,
            ChatMessage.session_id == identity.id,
            ChatMessage.role == "user",
            ChatMessage.created_at == turn.message_created_at,
            ChatMessage.content == turn.message_content,
        ).exists())
    with db.no_autoflush:
        result = await db.execute(
            update(ChatSession).where(*conditions).values(updated_at=utc_now())
            .execution_options(synchronize_session=False)
        )
    if result.rowcount != 1:
        await db.rollback()
        raise ChatSessionNotFound("这段对话已不可用，请打开其他对话或开始新对话。")


async def get_or_create_session(
    db: AsyncSession,
    current_user: User,
    session_id: int | None,
    message: str,
) -> ChatSession:
    if session_id is not None:
        return await find_owned_session(db, current_user.id, session_id)

    session = ChatSession(
        user_id=current_user.id,
        title=message[:50] + ("..." if len(message) > 50 else ""),
    )
    db.add(session)
    await db.commit()
    # Defaults are already populated by the INSERT. Refreshing after commit
    # could replace this identity with a newly created row reusing the ID.
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
    turn_identity: ChatTurnIdentity | None = None,
) -> tuple[list[Message], list]:
    query = select(ChatMessage).where(ChatMessage.session_id == session.id)
    if turn_identity is not None:
        original_session = turn_identity.session
        query = query.join(ChatSession).where(
            ChatSession.user_id == original_session.user_id,
            ChatSession.created_at == original_session.created_at,
            ChatMessage.id <= turn_identity.message_id,
        )
    result = await db.execute(query.order_by(ChatMessage.id.asc()))
    history = result.scalars().all()
    if turn_identity is not None and not any(
        item.id == turn_identity.message_id
        and item.created_at == turn_identity.message_created_at
        and item.role == "user"
        and item.content == turn_identity.message_content
        for item in history
    ):
        raise ChatSessionNotFound("这段对话已不可用，请打开其他对话或开始新对话。")
    messages: list[Message] = []
    rag_sources = []
    rag_context = None

    persona_prompt = PET_PERSONA_PROMPTS.get(pet_type or "")
    if persona_prompt:
        messages.append(Message(role="system", content=persona_prompt))

    if use_rag:
        rag_context = await run_in_threadpool(rag_service.build_context, user_id=user_id, question=user_message)
        rag_sources = rag_context.sources

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

    if rag_context and rag_context.context:
        messages.extend(knowledge_context_messages(rag_context.context))

    messages.extend(Message(role=item.role, content=item.content) for item in history)
    return messages, rag_sources


async def prepare_chat_turn(
    db: AsyncSession,
    current_user: User,
    request: ChatRequest,
    *,
    expected_session: ChatSessionIdentity | None = None,
) -> PreparedChatTurn:
    session = await get_or_create_session(db, current_user, request.session_id, request.message)
    session_identity = expected_session or ChatSessionIdentity.from_session(session)
    if session.id != session_identity.id or current_user.id != session_identity.user_id:
        raise ChatSessionNotFound("这段对话已不可用，请打开其他对话或开始新对话。")

    # Release this write lock at commit, before RAG or model work begins.
    await acquire_session_write(db, session_identity)

    user_message = ChatMessage(
        session_id=session.id,
        role="user",
        # Daily/weekly summaries use this tag to count completed chat turns.
        # Attach it atomically with the assistant reply, after generation succeeds.
        pet_type=None,
        content=request.message,
    )
    db.add(user_message)
    await db.flush()
    identity = ChatTurnIdentity(
        session=session_identity,
        message_id=user_message.id,
        message_created_at=user_message.created_at,
        message_content=user_message.content,
    )
    await db.commit()

    messages, rag_sources = await build_history(
        db,
        session,
        user_id=current_user.id,
        user_message=request.message,
        use_rag=request.use_rag,
        pet_type=request.pet_type,
        compact_response=request.compact_response,
        turn_identity=identity,
    )
    return PreparedChatTurn(
        session=session,
        user_message_id=user_message.id,
        messages=messages,
        rag_sources=rag_sources,
        identity=identity,
    )


async def save_assistant_message(
    db: AsyncSession,
    prepared_turn: PreparedChatTurn,
    content: str,
    *,
    pet_type: str | None,
) -> None:
    identity = prepared_turn.identity
    await acquire_session_write(db, identity.session, turn=identity)
    await db.execute(
        update(ChatMessage)
        .where(ChatMessage.id == identity.message_id, ChatMessage.session_id == identity.session.id)
        .values(pet_type=pet_type)
        .execution_options(synchronize_session=False)
    )
    db.add(
        ChatMessage(
            session_id=identity.session.id,
            role="assistant",
            content=content,
        )
    )
    await db.commit()


async def stream_response_chunks(messages: list[Message], *, stream: bool) -> AsyncIterator[str]:
    has_content = False
    try:
        async for chunk in llm_service.chat(messages, stream=stream):
            has_content = has_content or bool(chunk.strip())
            yield chunk
    except Exception as error:
        raise ChatProviderUnavailable(PROVIDER_UNAVAILABLE_MESSAGE) from error
    if not has_content:
        raise ChatProviderUnavailable(PROVIDER_UNAVAILABLE_MESSAGE)
