from concurrent.futures import ThreadPoolExecutor
import json
from threading import Barrier, Event
from types import SimpleNamespace
import uuid

import pytest

from app.services.rag.service import RAGService


class RecordingCollection:
    def __init__(self, *, batch_size=2, fail_on_batch=None):
        self.batch_size = batch_size
        self.fail_on_batch = fail_on_batch
        self.batches = []
        self.deletes = []
        self.rows = {"other:0": {"document_id": "999"}}

    def add(self, **batch):
        assert len(batch["ids"]) <= self.batch_size
        self.batches.append(batch)
        self.rows.update(zip(batch["ids"], batch["metadatas"]))
        if len(self.batches) == self.fail_on_batch:
            raise ValueError("index write failed")

    def get(self, *, where, include):
        assert include == []
        return {"ids": [key for key, metadata in self.rows.items() if metadata["document_id"] == where["document_id"]]}

    def delete(self, *, ids):
        assert len(ids) <= self.batch_size
        self.deletes.append(ids)
        self.rows = {key: metadata for key, metadata in self.rows.items() if key not in ids}


def prepared_service(monkeypatch, collection, chunks):
    service = RAGService()
    service._client = SimpleNamespace(max_batch_size=collection.batch_size)
    service._collection = collection
    monkeypatch.setattr(service, "extract_text", lambda **kwargs: "readable text")
    monkeypatch.setattr(service, "chunk_text", lambda text: chunks)
    monkeypatch.setattr(service, "embed_text", lambda text: [float(len(text))])
    return service


def index_sample(service):
    return service.index_document(7, 12, "notes.md", "unused.md", ".md")


def test_build_source_snippet_prefers_query_hit_window():
    service = RAGService()
    document = (
        "opening context "
        + ("background details " * 18)
        + "target answer appears in this middle section with the useful evidence "
        + ("trailing notes " * 12)
    )

    snippet = service.build_source_snippet(document, "target answer", max_length=90)

    assert "target answer" in snippet
    assert "opening context" not in snippet
    assert snippet.startswith("...")
    assert snippet.endswith("...")
    assert len(snippet) <= 96


def test_build_source_snippet_falls_back_to_chunk_start_without_hit():
    service = RAGService()
    document = "alpha beta " + ("background details " * 12)

    snippet = service.build_source_snippet(document, "unmatched query", max_length=40)

    assert snippet.startswith("alpha beta")
    assert snippet.endswith("...")


@pytest.mark.parametrize("batch_size", [2, 3, 8])
def test_index_document_honors_client_batch_limit_and_keeps_global_chunk_ids(monkeypatch, batch_size):
    chunks = [f"chunk {index}" for index in range(5)]
    collection = RecordingCollection(batch_size=batch_size)
    service = prepared_service(monkeypatch, collection, chunks)

    assert index_sample(service) == 5
    assert [item for batch in collection.batches for item in batch["ids"]] == [f"7:{index}" for index in range(5)]
    assert [item for batch in collection.batches for item in batch["documents"]] == chunks
    metadata = [item for batch in collection.batches for item in batch["metadatas"]]
    assert [item["chunk_index"] for item in metadata] == list(range(5))
    assert all(item["user_id"] == "12" and item["filename"] == "notes.md" for item in metadata)
    assert "other:0" in collection.rows


def test_index_document_cleans_even_partially_written_failed_batch(monkeypatch):
    collection = RecordingCollection(fail_on_batch=2)
    service = prepared_service(monkeypatch, collection, ["one", "two", "three", "four", "five"])

    with pytest.raises(ValueError, match="index write failed"):
        index_sample(service)

    assert len(collection.batches) == 2
    assert [len(ids) for ids in collection.deletes] == [2, 2]
    assert collection.rows == {"other:0": {"document_id": "999"}}


def test_index_document_cleans_prior_batches_when_embedding_fails(monkeypatch):
    collection = RecordingCollection()
    service = prepared_service(monkeypatch, collection, ["one", "two", "three"])

    def failing_embedding(text):
        if text.endswith("three"):
            raise ValueError("embedding failed")
        return [1.0]

    monkeypatch.setattr(service, "embed_text", failing_embedding)
    with pytest.raises(ValueError, match="embedding failed"):
        index_sample(service)
    assert len(collection.batches) == 1
    assert collection.rows == {"other:0": {"document_id": "999"}}


def test_index_document_preserves_original_error_if_compensation_also_fails(monkeypatch, caplog):
    collection = RecordingCollection(fail_on_batch=2)
    service = prepared_service(monkeypatch, collection, ["one", "two", "three"])
    original_delete = collection.delete

    def fail_cleanup(*, ids):
        if collection.batches:
            raise RuntimeError("cleanup unavailable")
        original_delete(ids=ids)

    monkeypatch.setattr(collection, "delete", fail_cleanup)
    with pytest.raises(ValueError, match="index write failed"):
        index_sample(service)
    assert "Failed to remove incomplete document index document_id=7" in caplog.text


def test_three_megabyte_text_indexes_across_default_sqlite_batch_limit(monkeypatch):
    collection = RecordingCollection(batch_size=5461)
    service = RAGService()
    service._client = SimpleNamespace(max_batch_size=collection.batch_size)
    service._collection = collection
    text = "alpha " * 500_000
    monkeypatch.setattr(service, "extract_text", lambda **kwargs: text)
    monkeypatch.setattr(service, "embed_text", lambda text: [1.0])

    assert len(text.encode()) == 3_000_000
    assert index_sample(service) == 6667
    assert [len(batch["ids"]) for batch in collection.batches] == [5461, 1206]


def test_delete_document_batches_only_matching_document_ids(monkeypatch):
    collection = RecordingCollection(batch_size=2)
    service = prepared_service(monkeypatch, collection, [])
    collection.rows.update({f"7:{index}": {"document_id": "7"} for index in range(5)})

    service.delete_document(7)

    assert [len(ids) for ids in collection.deletes] == [2, 2, 1]
    assert [item for batch in collection.deletes for item in batch] == [f"7:{index}" for index in range(5)]
    assert collection.rows == {"other:0": {"document_id": "999"}}
    service.delete_document(7)
    assert len(collection.deletes) == 3


def test_collection_initializes_once_across_worker_threads():
    service = RAGService()
    barrier = Barrier(4)
    collections = []

    def create_collection(**kwargs):
        from time import sleep

        sleep(0.02)
        collection = object()
        collections.append(collection)
        return collection

    service._client = SimpleNamespace(get_or_create_collection=create_collection)

    def get_collection():
        barrier.wait(timeout=3)
        return service._get_collection()

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: get_collection(), range(4)))

    assert len(collections) == 1
    assert all(result is collections[0] for result in results)


def test_query_waits_until_all_index_batches_finish(monkeypatch):
    collection = RecordingCollection()
    service = prepared_service(monkeypatch, collection, ["one", "two", "three"])
    first_batch_written = Event()
    allow_index_to_finish = Event()
    query_started = Event()
    queried_counts = []
    original_add = collection.add

    def blocking_add(**batch):
        original_add(**batch)
        if len(collection.batches) == 1:
            first_batch_written.set()
            assert allow_index_to_finish.wait(timeout=3)

    def query(**kwargs):
        queried_counts.append(sum(metadata["document_id"] == "7" for metadata in collection.rows.values()))
        return {"documents": [[]], "metadatas": [[]]}

    def query_context():
        query_started.set()
        return service.build_context(12, "one")

    monkeypatch.setattr(collection, "add", blocking_add)
    monkeypatch.setattr(collection, "query", query, raising=False)
    with ThreadPoolExecutor(max_workers=2) as pool:
        index_future = pool.submit(index_sample, service)
        try:
            assert first_batch_written.wait(timeout=3)
            query_future = pool.submit(query_context)
            assert query_started.wait(timeout=3)
            with pytest.raises(TimeoutError):
                query_future.result(timeout=0.05)
            assert queried_counts == []
        finally:
            allow_index_to_finish.set()
        assert index_future.result(timeout=3) == 3
        assert query_future.result(timeout=3).sources == []
    assert queried_counts == [3]


@pytest.mark.asyncio
async def test_cancelled_owner_operation_waiter_does_not_leak_lock():
    import asyncio

    service = RAGService()
    entered = []

    async def operation():
        async with service.user_operation(12):
            entered.append("waiter")

    async with service.user_operation(12):
        waiter = asyncio.create_task(operation())
        await asyncio.sleep(0)
        assert service._user_operations[12][1] == 2
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert service._user_operations[12][1] == 1
        async with service.user_operation(13):
            entered.append("other user")

    assert service._user_operations == {}
    await operation()
    assert entered == ["other user", "waiter"]
    assert service._user_operations == {}


@pytest.mark.parametrize("question", ["", "   ", "!!!", "🐱✨"])
def test_query_without_tokens_does_not_open_or_search_the_index(monkeypatch, question):
    service = RAGService()

    def unexpected_collection():
        pytest.fail("A zero-vector query must not open or search Chroma")

    monkeypatch.setattr(service, "_get_collection", unexpected_collection)
    context = service.build_context(12, question)
    assert context.context == ""
    assert context.sources == []


def test_query_keeps_positive_correlation_and_rejects_invalid_or_unrelated_distances():
    service = RAGService()
    distances = [0.0, 0.999999, 1.0, 1.01, float("nan"), float("inf")]
    calls = []

    def query(**kwargs):
        calls.append(kwargs)
        return {
            "documents": [[f"document {index}" for index in range(len(distances))]],
            "metadatas": [[{"document_id": str(index), "filename": f"{index}.md"} for index in range(len(distances))]],
            "distances": [distances],
        }

    service._collection = SimpleNamespace(query=query)
    context = service.build_context(12, "document", top_k=6)

    assert [source.document_id for source in context.sources] == [0, 1]
    assert [document["document_id"] for document in json.loads(context.context)["documents"]] == [0, 1]
    assert calls[0]["where"] == {"user_id": "12"}
    assert calls[0]["n_results"] == 6
    assert "distances" in calls[0]["include"]


def test_real_cosine_index_preserves_related_hits_and_owner_isolation(tmp_path):
    import chromadb
    from chromadb.config import Settings as ChromaSettings

    client = chromadb.EphemeralClient(settings=ChromaSettings(anonymized_telemetry=False))
    collection_name = f"rag-relevance-{uuid.uuid4().hex}"
    collection = client.create_collection(collection_name, metadata={"hnsw:space": "cosine"})
    service = RAGService()
    service._client = client
    service._collection = collection
    document = tmp_path / "banana.txt"
    document.write_text("banana", encoding="utf-8")
    try:
        assert service.index_document(7, 12, document.name, str(document), ".txt") == 1
        assert collection.metadata["hnsw:space"] == "cosine"
        assert sum(a * b for a, b in zip(service.embed_text("quasar"), service.embed_text("banana.txt banana"))) == 0

        related = service.build_context(12, "banana")
        assert [source.document_id for source in related.sources] == [7]
        assert related.sources[0].snippet == "banana"
        assert json.loads(related.context)["documents"] == [
            {"document_id": 7, "filename": "banana.txt", "content": "banana"},
        ]
        assert service.build_context(12, "quasar").sources == []
        assert service.build_context(13, "banana").sources == []

        service.delete_document(7)
        assert service.build_context(12, "banana").sources == []
    finally:
        client.delete_collection(collection_name)
