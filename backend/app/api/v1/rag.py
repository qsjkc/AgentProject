import asyncio
import logging
from pathlib import Path
import uuid

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import get_current_user
from app.models.database import get_db
from app.models.document import Document
from app.models.user import User
from app.schemas.rag import DocumentResponse, RAGQueryRequest, RAGQueryResponse
from app.services.llm.base import Message
from app.services.llm.service import llm_service
from app.services.rag import rag_service
from app.services.rag.prompts import knowledge_context_messages

router = APIRouter(prefix="/rag", tags=["rag"])
logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".txt", ".md", ".pdf"}


async def get_document_operation_user(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    async with rag_service.user_operation(current_user.id):
        # Authentication may have completed before an administrator's pending
        # deletion. Check again after acquiring the owner's operation lock.
        owner_id = await db.scalar(select(User.id).where(User.id == current_user.id))
        if owner_id is None:
            raise HTTPException(status_code=401, detail="User no longer exists")
        yield current_user


@router.post("/upload", response_model=DocumentResponse)
async def upload_document(
    file: UploadFile = File(...),
    current_user: User = Depends(get_document_operation_user),
    db: AsyncSession = Depends(get_db),
):
    upload_dir = Path(settings.UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)

    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type")

    result = await db.execute(select(func.count(Document.id)).where(Document.user_id == current_user.id))
    if (result.scalar_one() or 0) >= settings.MAX_DOCUMENTS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Each user can upload up to {settings.MAX_DOCUMENTS_PER_USER} documents",
        )

    content = await file.read(settings.MAX_UPLOAD_SIZE + 1)
    if len(content) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File exceeds 10 MB limit")

    file_id = str(uuid.uuid4())
    file_path = upload_dir / f"{file_id}{file_ext}"
    async with aiofiles.open(file_path, "wb") as output:
        await output.write(content)

    document = Document(
        user_id=current_user.id,
        filename=file.filename or file_path.name,
        file_path=str(file_path),
        file_type=file_ext,
        file_size=len(content),
        status="uploaded",
    )
    db.add(document)
    await db.commit()
    await db.refresh(document)

    index_task = asyncio.create_task(
        run_in_threadpool(
            rag_service.index_document,
            document_id=document.id,
            user_id=current_user.id,
            filename=document.filename,
            file_path=document.file_path,
            file_type=document.file_type,
        )
    )
    try:
        # Cancelling the request cannot stop a worker thread. Keep ownership
        # until it exits, otherwise a following delete can race its late writes.
        chunk_count = await asyncio.shield(index_task)
        document.chunk_count = chunk_count
        document.status = "indexed"
        await db.commit()
        await db.refresh(document)
        return document
    except asyncio.CancelledError:
        try:
            await index_task
        except Exception:
            pass
        try:
            await run_in_threadpool(rag_service.delete_document, document.id)
        except Exception:
            logger.exception("Failed to clean cancelled upload document_id=%s", document.id)
        document.status = "failed"
        document.chunk_count = 0
        await db.commit()
        raise
    except Exception as exc:
        document.status = "failed"
        await db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Failed to index document: {exc}") from exc


@router.get("/documents", response_model=list[DocumentResponse])
async def get_documents(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Document).where(Document.user_id == current_user.id).order_by(Document.created_at.desc())
    )
    return result.scalars().all()


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: int,
    current_user: User = Depends(get_document_operation_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Document).where(
            Document.id == document_id,
            Document.user_id == current_user.id,
        )
    )
    document = result.scalar_one_or_none()
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    await run_in_threadpool(rag_service.delete_document, document.id)

    file_path = Path(document.file_path)
    await run_in_threadpool(file_path.unlink, missing_ok=True)

    await db.delete(document)
    await db.commit()
    return {"message": "Document deleted"}


@router.post("/query", response_model=RAGQueryResponse)
async def query_rag(
    request: RAGQueryRequest,
    current_user: User = Depends(get_current_user),
):
    context = await run_in_threadpool(
        rag_service.build_context,
        user_id=current_user.id,
        question=request.question,
        top_k=request.top_k,
    )
    if not context.sources:
        return RAGQueryResponse(
            answer="No relevant knowledge base content was found for this question.",
            sources=[],
        )

    messages = knowledge_context_messages(context.context)
    messages.append(Message(role="user", content=request.question))

    answer = ""
    try:
        async for chunk in llm_service.chat(messages, stream=False):
            answer += chunk
    except Exception:
        top_source = context.sources[0]
        answer = (
            "LLM provider is unavailable, returning the most relevant knowledge excerpt instead.\n\n"
            f"{top_source.filename}: {top_source.snippet}"
        )

    return RAGQueryResponse(answer=answer, sources=context.sources)
