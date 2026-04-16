from datetime import datetime
from typing import Literal, Optional, List
from pydantic import BaseModel
from enum import Enum

from app.schemas.rag import RAGSource


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class ChatMessageBase(BaseModel):
    content: str


class ChatMessageCreate(ChatMessageBase):
    pass


class ChatMessageResponse(ChatMessageBase):
    id: int
    session_id: int
    role: MessageRole
    created_at: datetime
    
    model_config = {"from_attributes": True}


class ChatSessionBase(BaseModel):
    title: Optional[str] = "New Chat"


class ChatSessionCreate(ChatSessionBase):
    pass


class ChatSessionResponse(ChatSessionBase):
    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime
    messages: List[ChatMessageResponse] = []
    
    model_config = {"from_attributes": True}


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None
    use_rag: bool = False
    stream: bool = True
    pet_type: Optional[Literal["cat", "dog", "pig"]] = None
    compact_response: bool = False


class ChatResponse(BaseModel):
    content: str
    session_id: int
    role: MessageRole = MessageRole.ASSISTANT
    done: bool = True
    knowledge_used: bool = False
    sources: List[RAGSource] = []


class StreamChunk(BaseModel):
    content: str
    done: bool = False
    session_id: Optional[int] = None
    knowledge_used: bool = False
    sources: List[RAGSource] = []
