from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List

import chromadb
from pypdf import PdfReader

from app.core.config import settings
from app.schemas.rag import RAGSource


@dataclass
class RAGContext:
    context: str
    sources: List[RAGSource]


class RAGService:
    def __init__(self) -> None:
        self._client: chromadb.PersistentClient | None = None
        self._collection = None

    def _get_client(self) -> chromadb.PersistentClient:
        if self._client is None:
            Path(settings.CHROMA_PERSIST_DIR).mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(path=settings.CHROMA_PERSIST_DIR)
        return self._client

    def _get_collection(self):
        if self._collection is None:
            self._collection = self._get_client().get_or_create_collection(
                name="detachym_rag",
                metadata={"hnsw:space": "cosine"},
            )
        return self._collection

    def _tokenize(self, text: str) -> list[str]:
        normalized = text.lower()
        tokens = re.findall(r"[a-z0-9_]+", normalized)

        for segment in re.findall(r"[\u4e00-\u9fff]+", normalized):
            tokens.extend(segment)
            tokens.extend(segment[index : index + 2] for index in range(len(segment) - 1))

        return [token for token in tokens if token]

    def embed_text(self, text: str) -> list[float]:
        vector = [0.0] * settings.EMBEDDING_DIMENSION
        for token in self._tokenize(text):
            digest = hashlib.md5(token.encode("utf-8")).hexdigest()
            index = int(digest, 16) % settings.EMBEDDING_DIMENSION
            vector[index] += 1.0

        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def chunk_text(self, text: str) -> list[str]:
        normalized = re.sub(r"\s+", " ", text).strip()
        if not normalized:
            return []

        chunks: list[str] = []
        start = 0
        while start < len(normalized):
            end = min(start + settings.CHUNK_SIZE, len(normalized))
            chunk = normalized[start:end].strip()
            if chunk:
                chunks.append(chunk)
            if end >= len(normalized):
                break
            start = max(end - settings.CHUNK_OVERLAP, start + 1)
        return chunks

    def extract_text(self, file_path: str, file_type: str | None) -> str:
        path = Path(file_path)
        suffix = (file_type or path.suffix).lower()
        if suffix in {".txt", ".md"}:
            return path.read_text(encoding="utf-8", errors="ignore")
        if suffix == ".pdf":
            reader = PdfReader(str(path))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        raise ValueError("Unsupported file type")

    def index_document(self, document_id: int, user_id: int, filename: str, file_path: str, file_type: str | None) -> int:
        text = self.extract_text(file_path=file_path, file_type=file_type)
        chunks = self.chunk_text(text)
        if not chunks:
            raise ValueError("Document has no readable content")

        collection = self._get_collection()
        self.delete_document(document_id)

        collection.add(
            ids=[f"{document_id}:{index}" for index in range(len(chunks))],
            documents=chunks,
            embeddings=[self.embed_text(f"{filename} {chunk}") for chunk in chunks],
            metadatas=[
                {
                    "document_id": str(document_id),
                    "user_id": str(user_id),
                    "filename": filename,
                    "chunk_index": index,
                }
                for index in range(len(chunks))
            ],
        )
        return len(chunks)

    def delete_document(self, document_id: int) -> None:
        collection = self._get_collection()
        collection.delete(where={"document_id": str(document_id)})

    def build_context(self, user_id: int, question: str, top_k: int | None = None) -> RAGContext:
        collection = self._get_collection()
        results = collection.query(
            query_embeddings=[self.embed_text(question)],
            n_results=top_k or settings.RAG_TOP_K,
            where={"user_id": str(user_id)},
            include=["documents", "metadatas"],
        )

        documents = results.get("documents", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]
        sources: list[RAGSource] = []
        context_parts: list[str] = []

        for index, document in enumerate(documents):
            metadata = metadatas[index] if index < len(metadatas) else {}
            filename = metadata.get("filename", "Unknown")
            document_id = int(metadata.get("document_id", 0))
            snippet = document[:280]
            sources.append(
                RAGSource(
                    document_id=document_id,
                    filename=filename,
                    snippet=snippet,
                )
            )
            context_parts.append(f"[{filename}] {document}")

        return RAGContext(
            context="\n\n".join(context_parts),
            sources=sources,
        )


rag_service = RAGService()
