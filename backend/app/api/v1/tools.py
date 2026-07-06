from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.security import get_current_user, get_internal_service_identity
from app.models.user import User
from app.services.llm.base import Message
from app.services.llm.service import llm_service
from app.services.chat.service import PET_PERSONA_PROMPTS
from app.services.tools.weather import weather_service

router = APIRouter(prefix="/tools", tags=["tools"])


class InternalChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"] = "user"
    content: str = Field(default="", max_length=2000)


class InternalChatRequest(BaseModel):
    messages: list[InternalChatMessage] = Field(default_factory=list, max_length=12)
    compact: bool = True
    pet_type: Literal["cat", "dog", "pig"] | None = None


class InternalChatResponse(BaseModel):
    content: str


@router.get("/providers")
async def get_providers(current_user: User = Depends(get_current_user)):
    return {
        "current": llm_service.current_provider,
        "available": llm_service.available_providers,
    }


@router.get("/weather")
async def get_weather(city: str = "Beijing"):
    return await weather_service.get_weather(city)


@router.get("/internal/weather")
async def get_internal_weather(
    city: str = "Beijing",
    _: str = Depends(get_internal_service_identity),
):
    return await weather_service.get_weather(city)


@router.post("/internal/chat", response_model=InternalChatResponse)
async def get_internal_chat(
    request: InternalChatRequest,
    _: str = Depends(get_internal_service_identity),
):
    messages: list[Message] = [
        Message(
            role="system",
            content=(
                "你是 Detachym 桌宠语音助手。你可以回答日常问题、常识问题、轻量建议，"
                "也可以配合工具回答时间、天气和平台状态。回答要适合语音播报，直接、自然、简短；"
                "不要输出 Markdown，不要提及内部工具或系统实现。"
            ),
        )
    ]
    if request.compact:
        messages.append(
            Message(
                role="system",
                content=(
                    "请优先用 1 到 3 句中文回答，除非用户明确要求详细解释。"
                    "如果用户问生活建议或常识短问题，直接给一个可执行建议；不要只说请说清楚。"
                ),
            )
        )
    persona_prompt = PET_PERSONA_PROMPTS.get(request.pet_type or "")
    if persona_prompt:
        messages.append(Message(role="system", content=persona_prompt))

    for item in request.messages[-8:]:
        content = item.content.strip()
        if not content:
            continue
        messages.append(Message(role=item.role, content=content))

    if not any(message.role == "user" for message in messages):
        return InternalChatResponse(content="我没有收到明确的问题，请再说一次。")

    full_response = ""
    async for chunk in llm_service.chat(messages, stream=False, temperature=0.5, max_tokens=220):
        full_response += chunk

    content = full_response.strip() or "我暂时没有整理出可播报的回答。"
    return InternalChatResponse(content=content)
