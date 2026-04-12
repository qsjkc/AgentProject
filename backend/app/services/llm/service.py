from typing import AsyncGenerator, List, Optional
from enum import Enum

from app.core.config import settings
from app.core.logging import logger
from app.services.llm.base import LLMProvider, Message
from app.services.llm.zhipu import ZhipuProvider


class ProviderType(str, Enum):
    ZHIPU = "zhipu"


class LLMService:
    def __init__(self):
        self._providers: dict[ProviderType, LLMProvider] = {}
        self._current_provider = ProviderType.ZHIPU
        self._init_providers()
    
    def _init_providers(self):
        if settings.ZHIPU_API_KEY:
            self._providers[ProviderType.ZHIPU] = ZhipuProvider(
                api_key=settings.ZHIPU_API_KEY,
                base_url=settings.ZHIPU_BASE_URL,
                model=settings.ZHIPU_MODEL
            )
            logger.info("Zhipu provider initialized")
    
    def get_provider(self) -> LLMProvider:
        if self._current_provider not in self._providers:
            raise ValueError(f"Provider {self._current_provider} is not configured")
        return self._providers[self._current_provider]
    
    async def chat(
        self,
        messages: List[Message],
        stream: bool = True,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> AsyncGenerator[str, None]:
        if not self._providers:
            yield "LLM provider is not configured. Add a valid API key to enable AI responses."
            return

        llm_provider = self.get_provider()
        try:
            if stream:
                async for chunk in llm_provider.chat(
                    messages, stream=True, temperature=temperature, max_tokens=max_tokens
                ):
                    yield chunk
            else:
                result = await llm_provider.chat_sync(messages, temperature, max_tokens)
                yield result
        except Exception as e:
            logger.error(f"LLM error: {e}")
            raise e
    
    @property
    def current_provider(self) -> ProviderType:
        return self._current_provider
    
    @property
    def available_providers(self) -> List[ProviderType]:
        return list(self._providers.keys())

    @property
    def is_configured(self) -> bool:
        return bool(self._providers)


llm_service = LLMService()
