from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from app.config import Settings


class BackendToolClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _internal_headers(self) -> dict[str, str]:
        if not self._settings.BACKEND_INTERNAL_API_KEY:
            return {}
        return {"X-Internal-Api-Key": self._settings.BACKEND_INTERNAL_API_KEY}

    def _backend_base_urls(self) -> list[str]:
        urls = [self._settings.BACKEND_BASE_URL]
        fallback = self._settings.BACKEND_FALLBACK_BASE_URL
        if fallback and fallback not in urls:
            urls.append(fallback)
        return urls

    async def _request_backend_json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_payload: dict | None = None,
    ) -> dict:
        last_error: Exception | None = None
        for base_url in self._backend_base_urls():
            try:
                async with httpx.AsyncClient(timeout=self._settings.tool_timeout_seconds) as client:
                    response = await client.request(
                        method,
                        f"{base_url}{path}",
                        params=params,
                        json=json_payload,
                        headers=self._internal_headers(),
                    )
                    response.raise_for_status()
                    payload = response.json()
                if isinstance(payload, dict):
                    return payload
                raise RuntimeError("backend returned non-object JSON")
            except Exception as exc:  # pragma: no cover - caller converts to natural language
                last_error = exc
                continue

        if last_error:
            raise last_error
        raise RuntimeError("backend base URL is not configured")

    async def _get_backend_json(self, path: str, *, params: dict[str, str] | None = None) -> dict:
        return await self._request_backend_json("GET", path, params=params)

    async def _post_backend_json(self, path: str, *, json_payload: dict) -> dict:
        return await self._request_backend_json("POST", path, json_payload=json_payload)

    async def get_current_time(self) -> str:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        return now.strftime("现在是北京时间 %Y-%m-%d %H:%M:%S。")

    async def get_demo_weather(self, city: str = "Beijing") -> str:
        payload = await self._get_backend_json(
            "/api/v1/tools/internal/weather",
            params={"city": city},
        )
        weather = payload.get("weather", "未知")
        temperature = payload.get("temperature", "未知")
        reported_city = payload.get("city", city)
        note = payload.get("note")
        if note:
            return f"{reported_city} 当前天气 {weather}，气温 {temperature}。备注：{note}"
        return f"{reported_city} 当前天气 {weather}，气温 {temperature}。"

    async def get_platform_status(self) -> str:
        payload = await self._get_backend_json("/health/ready")
        return f"平台状态正常，当前后端就绪状态是 {payload.get('status', 'ready')}。"

    async def get_project_chat(self, messages: list[dict[str, str]], pet_type: str | None = None) -> str:
        json_payload = {
            "messages": messages[-8:],
            "compact": True,
        }
        if pet_type in {"cat", "dog", "pig"}:
            json_payload["pet_type"] = pet_type

        payload = await self._post_backend_json(
            "/api/v1/tools/internal/chat",
            json_payload=json_payload,
        )
        content = str(payload.get("content") or "").strip()
        return content or "我暂时没有整理出可播报的回答。"
