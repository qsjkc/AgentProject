import json
import asyncio
import logging
import sys
from types import SimpleNamespace

import httpx
import pytest

@pytest.fixture(autouse=True)
async def close_mock_response_iterators():
    yield
    # httpx 0.27 nests async generators inside aiter_lines. Complete their
    # finalizers before pytest closes this test's isolated event loop.
    await asyncio.get_running_loop().shutdown_asyncgens()


def sse(payload):
    return f"data: {json.dumps(payload)}\n\n"


def install_response(monkeypatch, body, *, streaming=True, status=200):
    from app.services.llm import zhipu as zhipu_module

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            status,
            content=body.encode() if isinstance(body, str) else json.dumps(body).encode(),
            headers={"content-type": "text/event-stream" if streaming else "application/json"},
        )

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(
        zhipu_module, "httpx",
        SimpleNamespace(AsyncClient=lambda **kwargs: httpx.AsyncClient(transport=transport, **kwargs)),
    )
    return requests


@pytest.fixture
def provider(monkeypatch):
    # Standalone transport tests need no application settings or dotenv. In
    # the full suite test_main has already loaded the isolated app settings.
    if "app.core.logging" not in sys.modules:
        monkeypatch.setitem(sys.modules, "app.core.logging", SimpleNamespace(logger=logging.getLogger("test-zhipu")))
    from app.services.llm.zhipu import ZhipuProvider

    return ZhipuProvider(api_key="local-test-key", base_url="https://provider.invalid/v4", model="test-model")


@pytest.mark.asyncio
async def test_stream_accepts_complete_text_usage_and_sse_framing(monkeypatch, provider):
    from app.services.llm.base import Message

    body = (
        ": keepalive\n\n"
        'data:{"choices":[{"delta":{"role":"assistant"}}]}\n\n'
        'data: {"choices":\ndata: [{"delta":{"content":"完整回答"},"finish_reason":null}]}\n\n'
        + sse({"choices": [{"delta": {}, "finish_reason": "stop"}]})
        + sse({"choices": [], "usage": {"total_tokens": 10}})
        + "data: [DONE]\n\n"
    )
    requests = install_response(monkeypatch, body)
    assert [chunk async for chunk in provider.chat([Message(role="user", content="hello")])] == ["完整回答"]
    assert len(requests) == 1
    assert requests[0].url.path == "/v4/chat/completions"
    assert json.loads(requests[0].content)["stream"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["network_error", "sensitive", "model_context_window_exceeded", "length", "tool_calls", "unknown_failure"])
@pytest.mark.parametrize("streaming", [False, True])
async def test_non_success_finish_reason_rejects_even_nonempty_text(monkeypatch, provider, reason, streaming):
    choice = {"finish_reason": reason}
    choice["delta" if streaming else "message"] = {"content": "private unfinished content"}
    body = sse({"choices": [choice]}) + "data: [DONE]\n\n" if streaming else {"choices": [choice]}
    install_response(monkeypatch, body, streaming=streaming)
    with pytest.raises(RuntimeError, match="Zhipu returned an incomplete or invalid response") as failure:
        if streaming:
            assert [chunk async for chunk in provider.chat([])] == []
        else:
            await provider.chat_sync([])
    assert "private" not in str(failure.value)
    assert reason not in str(failure.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", [
    sse({"error": {"code": "private-code", "message": "private provider details"}}),
    'event: error\ndata: {"message":"private provider details"}\n\n',
    "data: {invalid-private-json}\n\n",
    sse({"unexpected": "private provider details"}),
    sse({"choices": []}),
    "",
    sse({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
])
async def test_partial_stream_error_or_eof_is_not_a_complete_answer(monkeypatch, provider, ending):
    body = sse({"choices": [{"delta": {"content": "provisional text"}}]}) + ending
    install_response(monkeypatch, body)
    received = []
    with pytest.raises(RuntimeError, match="Zhipu returned an incomplete or invalid response") as failure:
        async for chunk in provider.chat([]):
            received.append(chunk)
    assert received == ["provisional text"]
    assert "private" not in str(failure.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", " \n\t"])
@pytest.mark.parametrize("streaming", [False, True])
async def test_empty_answer_is_rejected_with_normal_termination(monkeypatch, provider, content, streaming):
    choice = {"finish_reason": "stop", "delta" if streaming else "message": {"content": content}}
    body = sse({"choices": [choice]}) + "data: [DONE]\n\n" if streaming else {"choices": [choice]}
    install_response(monkeypatch, body, streaming=streaming)
    with pytest.raises(RuntimeError, match="Zhipu returned an incomplete or invalid response"):
        if streaming:
            _ = [chunk async for chunk in provider.chat([])]
        else:
            await provider.chat_sync([])


@pytest.mark.asyncio
@pytest.mark.parametrize("include_reason", [False, True])
async def test_sync_accepts_stop_or_omitted_optional_reason(monkeypatch, provider, include_reason):
    choice = {"message": {"content": "complete answer"}}
    if include_reason:
        choice["finish_reason"] = "stop"
    requests = install_response(monkeypatch, {"choices": [choice]}, streaming=False)
    assert await provider.chat_sync([], max_tokens=220) == "complete answer"
    assert json.loads(requests[0].content)["max_tokens"] == 220
    assert json.loads(requests[0].content)["stream"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    {"error": {"message": "private provider details"}},
    {"choices": []},
    {"choices": [{"message": {"content": ["unexpected"]}}]},
    "{invalid-private-json}",
])
async def test_sync_error_payload_is_rejected_without_exposing_body(monkeypatch, provider, body):
    install_response(monkeypatch, body, streaming=False)
    with pytest.raises(RuntimeError, match="Zhipu returned an incomplete or invalid response") as failure:
        await provider.chat_sync([])
    assert "private" not in str(failure.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_http_failure_hides_provider_body(monkeypatch, provider, streaming):
    install_response(monkeypatch, "private upstream details", streaming=streaming, status=502)
    with pytest.raises(RuntimeError, match="Zhipu returned an incomplete or invalid response") as failure:
        if streaming:
            _ = [chunk async for chunk in provider.chat([])]
        else:
            await provider.chat_sync([])
    assert "private" not in str(failure.value)
