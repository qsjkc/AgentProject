from app.services.rag.service import RAGService


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
