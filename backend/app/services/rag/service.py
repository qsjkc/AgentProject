from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from asyncio import Lock
from contextlib import asynccontextmanager
from threading import RLock
from dataclasses import dataclass
from pathlib import Path
from typing import List

import chromadb
from pypdf import PdfReader

from app.core.config import settings
from app.schemas.rag import RAGSource

logger = logging.getLogger(__name__)


@dataclass
class RAGContext:
    context: str
    sources: List[RAGSource]


class RAGService:
    def __init__(self) -> None:
        self._client: chromadb.PersistentClient | None = None
        self._collection = None
        self._initialization_lock = RLock()
        self._index_lock = RLock()
        self._user_operations: dict[int, tuple[Lock, int]] = {}

    @asynccontextmanager
    async def user_operation(self, user_id: int):
        # Keep the index, upload file and async database commit in one ordered
        # operation per owner. A waiting request must share the same lock.
        lock, users = self._user_operations.get(user_id, (Lock(), 0))
        self._user_operations[user_id] = (lock, users + 1)
        try:
            async with lock:
                yield
        finally:
            _, remaining = self._user_operations[user_id]
            if remaining == 1:
                del self._user_operations[user_id]
            else:
                self._user_operations[user_id] = (lock, remaining - 1)

    def _get_client(self) -> chromadb.PersistentClient:
        with self._initialization_lock:
            if self._client is None:
                Path(settings.CHROMA_PERSIST_DIR).mkdir(parents=True, exist_ok=True)
                self._client = chromadb.PersistentClient(path=settings.CHROMA_PERSIST_DIR)
            return self._client

    def _get_collection(self):
        with self._initialization_lock:
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

    def build_source_snippet(self, document: str, question: str, max_length: int = 280) -> str:
        normalized_document = re.sub(r"\s+", " ", document).strip()
        if len(normalized_document) <= max_length:
            return normalized_document

        lowered_document = normalized_document.lower()
        query_tokens = sorted(
            {token.lower() for token in self._tokenize(question) if len(token.strip()) >= 2},
            key=len,
            reverse=True,
        )
        hit_index = -1
        for token in query_tokens:
            token_index = lowered_document.find(token)
            if token_index >= 0:
                hit_index = token_index
                break

        if hit_index < 0:
            return f"{normalized_document[:max_length].rstrip()}..."

        start = max(0, hit_index - max_length // 3)
        end = min(len(normalized_document), start + max_length)
        if end - start < max_length:
            start = max(0, end - max_length)

        snippet = normalized_document[start:end].strip()
        if start > 0:
            snippet = f"...{snippet}"
        if end < len(normalized_document):
            snippet = f"{snippet}..."
        return snippet

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
        batch_size = self._get_client().max_batch_size
        if batch_size < 1:
            raise ValueError("Document index batch size must be positive")

        # Chroma's batch limit follows the local SQLite variable limit. Keep
        # reads and deletes outside a partially written or failed replacement.
        with self._index_lock:
            self.delete_document(document_id)
            try:
                for start in range(0, len(chunks), batch_size):
                    batch = chunks[start : start + batch_size]
                    collection.add(
                        ids=[f"{document_id}:{start + offset}" for offset in range(len(batch))],
                        documents=batch,
                        embeddings=[self.embed_text(f"{filename} {chunk}") for chunk in batch],
                        metadatas=[
                            {
                                "document_id": str(document_id),
                                "user_id": str(user_id),
                                "filename": filename,
                                "chunk_index": start + offset,
                            }
                            for offset in range(len(batch))
                        ],
                    )
            except Exception:
                try:
                    self.delete_document(document_id)
                except Exception:
                    logger.exception("Failed to remove incomplete document index document_id=%s", document_id)
                raise
        return len(chunks)

    def delete_document(self, document_id: int) -> None:
        collection = self._get_collection()
        batch_size = self._get_client().max_batch_size
        if batch_size < 1:
            raise ValueError("Document index batch size must be positive")
        with self._index_lock:
            # A filtered delete also enters Chroma's embedding operation queue,
            # so it has the same batch limit as adding a large document.
            ids = collection.get(where={"document_id": str(document_id)}, include=[])["ids"]
            for start in range(0, len(ids), batch_size):
                collection.delete(ids=ids[start : start + batch_size])

    def build_context(self, user_id: int, question: str, top_k: int | None = None) -> RAGContext:
        query_embedding = self.embed_text(question)
        if not any(query_embedding):
            return RAGContext(context="", sources=[])

        collection = self._get_collection()
        with self._index_lock:
            results = collection.query(
                query_embeddings=[query_embedding],
                n_results=top_k or settings.RAG_TOP_K,
                where={"user_id": str(user_id)},
                include=["documents", "metadatas", "distances"],
            )

        documents = results.get("documents", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0]
        sources: list[RAGSource] = []
        context_parts: list[dict] = []

        for index, document in enumerate(documents):
            # This collection uses cosine distance. A distance of one or more
            # has no positive correlation; keep every positively related hit.
            distance = distances[index] if index < len(distances) else None
            if distance is None or not math.isfinite(distance) or distance >= 1:
                continue
            metadata = metadatas[index] if index < len(metadatas) else {}
            filename = metadata.get("filename", "Unknown")
            document_id = int(metadata.get("document_id", 0))
            snippet = self.build_source_snippet(document, question)
            sources.append(
                RAGSource(
                    document_id=document_id,
                    filename=filename,
                    snippet=snippet,
                )
            )
            context_parts.append({
                "document_id": document_id,
                "filename": filename,
                "content": document,
            })

        return RAGContext(
            # JSON strings retain untrusted quotes, newlines and delimiter-like
            # text as field values instead of creating another prompt section.
            context=json.dumps({
                "type": "untrusted_knowledge_base_context",
                "documents": context_parts,
            }, ensure_ascii=False) if context_parts else "",
            sources=sources,
        )


rag_service = RAGService()
