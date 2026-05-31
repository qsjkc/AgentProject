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

    async def get_current_time(self) -> str:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        return now.strftime("现在是北京时间 %Y-%m-%d %H:%M:%S。")

    async def get_demo_weather(self, city: str = "Beijing") -> str:
        async with httpx.AsyncClient(timeout=self._settings.tool_timeout_seconds) as client:
            response = await client.get(
                f"{self._settings.BACKEND_BASE_URL}/api/v1/tools/internal/weather",
                params={"city": city},
                headers=self._internal_headers(),
            )
            response.raise_for_status()
            payload = response.json()
        weather = payload.get("weather", "未知")
        temperature = payload.get("temperature", "未知")
        reported_city = payload.get("city", city)
        note = payload.get("note")
        if note:
            return f"{reported_city} 当前天气 {weather}，气温 {temperature}。备注：{note}"
        return f"{reported_city} 当前天气 {weather}，气温 {temperature}。"

    async def get_platform_status(self) -> str:
        async with httpx.AsyncClient(timeout=self._settings.tool_timeout_seconds) as client:
            response = await client.get(
                f"{self._settings.BACKEND_BASE_URL}/health/ready",
                headers=self._internal_headers(),
            )
            if response.status_code == 200:
                payload = response.json()
                return f"平台状态正常，当前后端就绪状态是 {payload.get('status', 'ready')}。"
            detail = response.json().get("detail")
            return f"平台当前未完全就绪，后端返回了 {detail!s}。"
