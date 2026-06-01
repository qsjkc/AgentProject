from __future__ import annotations

import asyncio
import json
import logging
import time
from uuid import uuid4

from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

from app.agent import VoiceDemoAgent
from app.auth import OpenAIHTTPError, openai_error_payload, require_api_key
from app.config import Settings, get_settings
from app.schemas import (
    ChatCompletionChoice,
    ChatCompletionChoiceMessage,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionUsage,
)
from app.tools import BackendToolClient


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _estimate_usage(prompt_text: str, response_text: str) -> ChatCompletionUsage:
    prompt_tokens = max(1, len(prompt_text) // 2)
    completion_tokens = max(1, len(response_text) // 2)
    return ChatCompletionUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
    )


def _latest_user_text(request: ChatCompletionRequest) -> str:
    for message in reversed(request.messages):
        if message.role == "user" and message.content.strip():
            return message.content.strip()
    return ""


def _chunk_text(text: str, *, chunk_size: int = 12) -> list[str]:
    compact = text.strip()
    if not compact:
        return []
    return [compact[index : index + chunk_size] for index in range(0, len(compact), chunk_size)]


def _chunk_payload(*, completion_id: str, created: int, model: str, content: str, finish_reason: str | None) -> dict:
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content},
                "finish_reason": finish_reason,
            }
        ],
    }


def create_app(
    *,
    settings_override: Settings | None = None,
    tools_override: BackendToolClient | None = None,
) -> FastAPI:
    settings = settings_override or get_settings()
    _configure_logging(settings.AGENT_LOG_LEVEL)

    app = FastAPI(title="Voice Demo Agent Server", version="1.0.0")
    app.state.settings = settings
    app.state.agent = VoiceDemoAgent(settings, tools_override)

    @app.exception_handler(OpenAIHTTPError)
    async def openai_http_error_handler(_, exc: OpenAIHTTPError):
        return JSONResponse(
            status_code=exc.status_code,
            content=openai_error_payload(exc.message, code=exc.code, error_type=exc.error_type),
            headers={"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None,
        )

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/v1/chat/completions")
    async def chat_completions(
        request: ChatCompletionRequest,
        _: str = Depends(require_api_key),
    ):
        model_name = request.model or settings.AGENT_MODEL_NAME
        if request.stream:
            return StreamingResponse(
                _stream_chat_completion(
                    agent=app.state.agent,
                    request=request,
                    model_name=model_name,
                    first_chunk_timeout_seconds=settings.first_chunk_timeout_seconds,
                ),
                media_type="text/event-stream; charset=utf-8",
            )

        response_text = await app.state.agent.complete_text(request)
        prompt_text = _latest_user_text(request)
        response = ChatCompletionResponse(
            id=f"chatcmpl_{uuid4().hex}",
            created=int(time.time()),
            model=model_name,
            choices=[
                ChatCompletionChoice(
                    message=ChatCompletionChoiceMessage(content=response_text),
                )
            ],
            usage=_estimate_usage(prompt_text, response_text),
        )
        return response.model_dump()

    return app


async def _stream_chat_completion(
    *,
    agent: VoiceDemoAgent,
    request: ChatCompletionRequest,
    model_name: str,
    first_chunk_timeout_seconds: float,
):
    completion_id = f"chatcmpl_{uuid4().hex}"
    created = int(time.time())
    task = asyncio.create_task(agent.complete_text(request))
    initial_payload = _chunk_payload(
        completion_id=completion_id,
        created=created,
        model=model_name,
        content="",
        finish_reason=None,
    )
    yield f"data: {json.dumps(initial_payload, ensure_ascii=False)}\n\n"

    try:
        response_text = await asyncio.wait_for(asyncio.shield(task), timeout=first_chunk_timeout_seconds)
    except asyncio.TimeoutError:
        waiting_payload = _chunk_payload(
            completion_id=completion_id,
            created=created,
            model=model_name,
            content="我正在处理，请稍等。",
            finish_reason=None,
        )
        yield f"data: {json.dumps(waiting_payload, ensure_ascii=False)}\n\n"
        try:
            response_text = await task
        except Exception:  # pragma: no cover - defensive guard
            response_text = "我现在暂时处理不了这个请求，请稍后再试。"
    except Exception:  # pragma: no cover - defensive guard
        response_text = "我现在暂时处理不了这个请求，请稍后再试。"

    for piece in _chunk_text(response_text):
        payload = _chunk_payload(
            completion_id=completion_id,
            created=created,
            model=model_name,
            content=piece,
            finish_reason=None,
        )
        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    final_payload = _chunk_payload(
        completion_id=completion_id,
        created=created,
        model=model_name,
        content="",
        finish_reason="stop",
    )
    yield f"data: {json.dumps(final_payload, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


app = create_app()
