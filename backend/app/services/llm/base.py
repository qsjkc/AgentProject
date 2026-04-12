from abc import ABC, abstractmethod
from typing import AsyncGenerator, List, Optional
from pydantic import BaseModel


class Message(BaseModel):
    role: str
    content: str


class LLMProvider(ABC):
    def __init__(self, api_key: str, base_url: str, model: str):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
    
    @abstractmethod
    async def chat(
        self,
        messages: List[Message],
        stream: bool = True,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> AsyncGenerator[str, None]:
        pass
    
    @abstractmethod
    async def chat_sync(
        self,
        messages: List[Message],
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> str:
        pass
    
    def _convert_messages(self, messages: List[Message]) -> List[dict]:
        return [{"role": msg.role, "content": msg.content} for msg in messages]
