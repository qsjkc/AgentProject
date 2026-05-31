from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app.services.tools.weather import weather_service


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.reason_phrase = "OK"

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://example.com")
            raise httpx.HTTPStatusError("error", request=request, response=self)

    def json(self) -> dict:
        return self._payload


class FakeAsyncClient:
    def __init__(self, responses: list[FakeResponse], **_: object) -> None:
        self._responses = responses

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, params: dict | None = None):
        if not self._responses:
            raise AssertionError(f"Unexpected request to {url} with params {params}")
        return self._responses.pop(0)


@pytest.mark.asyncio
async def test_weather_service_returns_real_payload(monkeypatch):
    responses = [
        FakeResponse(
            {
                "results": [
                    {
                        "name": "Beijing",
                        "latitude": 39.9042,
                        "longitude": 116.4074,
                    }
                ]
            }
        ),
        FakeResponse(
            {
                "current": {
                    "time": "2026-05-30T16:00",
                    "temperature_2m": 28.4,
                    "apparent_temperature": 30.1,
                    "relative_humidity_2m": 41,
                    "weather_code": 1,
                    "wind_speed_10m": 12.3,
                },
                "current_units": {
                    "temperature_2m": "°C",
                    "apparent_temperature": "°C",
                    "wind_speed_10m": "km/h",
                },
                "daily": {
                    "temperature_2m_max": [31.2],
                    "temperature_2m_min": [19.5],
                },
                "daily_units": {
                    "temperature_2m_max": "°C",
                    "temperature_2m_min": "°C",
                },
            }
        ),
    ]

    monkeypatch.setattr(
        "app.services.tools.weather.httpx.AsyncClient",
        lambda **kwargs: FakeAsyncClient(responses, **kwargs),
    )

    payload = await weather_service.get_weather("Beijing")

    assert payload["city"] == "Beijing"
    assert payload["weather"] == "大部晴朗"
    assert payload["temperature"] == "28.4°C"
    assert payload["apparentTemperature"] == "30.1°C"
    assert payload["windSpeed"] == "12.3km/h"
    assert payload["humidity"] == "41%"
    assert payload["todayMaxTemperature"] == "31.2°C"
    assert payload["todayMinTemperature"] == "19.5°C"
    assert payload["source"] == "Open-Meteo"


@pytest.mark.asyncio
async def test_weather_service_raises_not_found_when_city_missing(monkeypatch):
    monkeypatch.setattr(
        "app.services.tools.weather.httpx.AsyncClient",
        lambda **kwargs: FakeAsyncClient([FakeResponse({"results": []})], **kwargs),
    )

    with pytest.raises(HTTPException) as exc_info:
        await weather_service.get_weather("MissingCity")

    assert exc_info.value.status_code == 404
    assert "Weather city not found" in exc_info.value.detail
