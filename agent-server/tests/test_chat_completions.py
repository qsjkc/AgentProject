import asyncio
import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app


class FakeTools:
    def __init__(
        self,
        *,
        weather_error: bool = False,
        weather_delay: float = 0,
        chat_error: bool = False,
        chat_response: str | None = None,
    ) -> None:
        self.weather_error = weather_error
        self.weather_delay = weather_delay
        self.chat_error = chat_error
        self.chat_response = chat_response
        self.last_weather_city: str | None = None
        self.last_chat_messages: list[dict[str, str]] | None = None
        self.last_pet_type: str | None = None

    async def get_current_time(self) -> str:
        return "现在是北京时间 2026-05-29 10:00:00。"

    async def get_demo_weather(self, city: str = "Beijing") -> str:
        self.last_weather_city = city
        if self.weather_delay:
            await asyncio.sleep(self.weather_delay)
        if self.weather_error:
            raise RuntimeError("weather backend unavailable")
        return f"{city} 当前天气 Sunny，气温 25°C。"

    async def get_platform_status(self) -> str:
        return "平台状态正常，当前后端就绪状态是 ready。"

    async def get_project_chat(self, messages: list[dict[str, str]], pet_type: str | None = None) -> str:
        self.last_chat_messages = messages
        self.last_pet_type = pet_type
        if self.chat_error:
            raise RuntimeError("chat backend unavailable")
        if self.chat_response is not None:
            return self.chat_response
        return "这是项目通用聊天能力给出的简短回答。"


@pytest_asyncio.fixture
async def client():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        yield ac


@pytest_asyncio.fixture
async def failing_weather_client():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools(weather_error=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        yield ac


def _auth_headers(token: str = "test-agent-key") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_health(client: AsyncClient):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_chat_completions_requires_auth(client: AsyncClient):
    response = await client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "你好"}]})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_api_key"


@pytest.mark.asyncio
async def test_chat_completions_rejects_wrong_bearer(client: AsyncClient):
    response = await client.post(
        "/v1/chat/completions",
        headers=_auth_headers("wrong-key"),
        json={"messages": [{"role": "user", "content": "你好"}]},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_api_key"


@pytest.mark.asyncio
async def test_chat_completions_non_stream_returns_openai_shape(client: AsyncClient):
    response = await client.post(
        "/v1/chat/completions",
        headers=_auth_headers(),
        json={
            "stream": False,
            "messages": [{"role": "user", "content": "现在几点了"}],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["object"] == "chat.completion"
    assert payload["choices"][0]["message"]["role"] == "assistant"
    assert "北京时间" in payload["choices"][0]["message"]["content"]


@pytest.mark.asyncio
async def test_chat_completions_stream_returns_sse(client: AsyncClient):
    async with client.stream(
        "POST",
        "/v1/chat/completions",
        headers=_auth_headers(),
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "今天天气怎么样"}],
        },
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = await response.aread()

    text = body.decode("utf-8")
    assert '"object": "chat.completion.chunk"' in text
    assert "data: [DONE]" in text
    assert text.strip().endswith("data: [DONE]")


@pytest.mark.asyncio
async def test_tool_failure_returns_fallback_text_not_500(failing_weather_client: AsyncClient):
    response = await failing_weather_client.post(
        "/v1/chat/completions",
        headers=_auth_headers(),
        json={
            "stream": False,
            "messages": [{"role": "user", "content": "天气怎么样"}],
        },
    )
    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "天气服务暂时不可用" in content


@pytest.mark.asyncio
async def test_chat_completions_weather_city_is_forwarded():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "上海天气怎么样"}],
            },
        )

    assert response.status_code == 200
    assert "上海 当前天气" in response.json()["choices"][0]["message"]["content"]
    assert tools.last_weather_city == "上海"


@pytest.mark.asyncio
async def test_chat_completions_weather_city_strips_query_prefix():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "帮我查询一下上海今天的天气"}],
            },
        )

    assert response.status_code == 200
    assert "上海 当前天气" in response.json()["choices"][0]["message"]["content"]
    assert tools.last_weather_city == "上海"


@pytest.mark.asyncio
async def test_chat_completions_weather_followup_uses_previous_weather_context():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [
                    {"role": "user", "content": "北京天气怎么样"},
                    {"role": "assistant", "content": "北京 当前天气 Sunny，气温 25°C。"},
                    {"role": "user", "content": "那上海呢"},
                ],
            },
        )

    assert response.status_code == 200
    assert "上海 当前天气" in response.json()["choices"][0]["message"]["content"]
    assert tools.last_weather_city == "上海"


@pytest.mark.asyncio
async def test_chat_completions_weather_without_city_defaults_to_beijing():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "今天天气怎么样"}],
            },
        )

    assert response.status_code == 200
    assert tools.last_weather_city == "Beijing"


@pytest.mark.asyncio
async def test_chat_completions_general_prompt_uses_project_chat_tool():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "火星上有猫吗"}],
            },
        )

    assert response.status_code == 200
    assert "项目通用聊天能力" in response.json()["choices"][0]["message"]["content"]
    assert tools.last_chat_messages
    assert tools.last_chat_messages[-1]["content"] == "火星上有猫吗"


@pytest.mark.asyncio
async def test_chat_completions_forwards_pet_persona_to_project_chat_tool():
    tools = FakeTools()
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=tools)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [
                    {"role": "system", "content": "You are speaking as a desktop dog companion."},
                    {"role": "user", "content": "火星上有猫吗"},
                ],
            },
        )

    assert response.status_code == 200
    assert tools.last_pet_type == "dog"


@pytest.mark.asyncio
async def test_chat_completions_general_prompt_failure_returns_fallback():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools(chat_error=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "火星上有猫吗"}],
            },
        )

    assert response.status_code == 200
    assert "没有证据表明火星上有猫" in response.json()["choices"][0]["message"]["content"]


@pytest.mark.asyncio
async def test_chat_completions_general_prompt_replaces_low_value_backend_reply():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools(chat_response="请说清楚您的问题，我会尽力帮助您。"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "我早饭吃什么比较好"}],
            },
        )

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "早餐建议" in content
    assert "鸡蛋" in content


@pytest.mark.asyncio
async def test_chat_completions_greeting_returns_short_capability_hint():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "你好"}],
            },
        )

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "日常问题" in content
    assert "天气" in content


@pytest.mark.asyncio
async def test_chat_completions_identity_returns_brief_intro():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "你是谁"}],
            },
        )

    assert response.status_code == 200
    assert "Detachym 桌宠语音助手" in response.json()["choices"][0]["message"]["content"]


@pytest.mark.asyncio
async def test_chat_completions_help_mentions_daily_questions():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=2000,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": False,
                "messages": [{"role": "user", "content": "你能做什么"}],
            },
        )

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "早餐建议" in content
    assert "平台状态" in content


@pytest.mark.asyncio
async def test_chat_completions_stream_does_not_cancel_slow_tool_result():
    settings = Settings(
        AGENT_API_KEY="test-agent-key",
        BACKEND_BASE_URL="http://backend.test",
        AGENT_FIRST_CHUNK_TIMEOUT_MS=50,
        AGENT_TOTAL_TIMEOUT_MS=5000,
        AGENT_TOOL_TIMEOUT_MS=1000,
    )
    app = create_app(settings_override=settings, tools_override=FakeTools(weather_delay=0.2))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        async with client.stream(
            "POST",
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "stream": True,
                "messages": [{"role": "user", "content": "上海天气怎么样"}],
            },
        ) as response:
            assert response.status_code == 200
            body = await response.aread()

    text = body.decode("utf-8")
    content = "".join(
        json.loads(line.removeprefix("data: "))["choices"][0]["delta"].get("content", "")
        for line in text.splitlines()
        if line.startswith("data: {")
    )
    assert "我正在处理，请稍等。" in text
    assert "上海 当前天气 Sunny" in content
    assert text.strip().endswith("data: [DONE]")
