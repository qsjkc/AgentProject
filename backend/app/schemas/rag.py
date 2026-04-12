from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class DocumentBase(BaseModel):
    filename: str


class DocumentCreate(DocumentBase):
    pass


class DocumentResponse(DocumentBase):
    id: int
    user_id: int
    file_type: Optional[str]
    file_size: Optional[int]
    chunk_count: int
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RAGQueryRequest(BaseModel):
    question: str = Field(min_length=1)
    top_k: int = Field(default=4, ge=1, le=10)


class RAGSource(BaseModel):
    document_id: int
    filename: str
    snippet: str


class RAGQueryResponse(BaseModel):
    answer: str
    sources: List[RAGSource] = []
