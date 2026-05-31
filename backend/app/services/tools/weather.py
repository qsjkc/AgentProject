from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status

from app.core.logging import logger


GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
REQUEST_TIMEOUT_SECONDS = 5.0

WMO_WEATHER_CODES = {
    0: "晴",
    1: "大部晴朗",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "冻雾",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "强毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "阵雨",
    81: "强阵雨",
    82: "暴雨阵雨",
    85: "阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "弱冰雹雷暴",
    99: "强冰雹雷暴",
}


class WeatherService:
    async def get_weather(self, city: str) -> dict[str, Any]:
        location = await self._resolve_location(city)
        forecast = await self._fetch_forecast(location)

        current = forecast.get("current") or {}
        current_units = forecast.get("current_units") or {}
        daily = forecast.get("daily") or {}
        daily_units = forecast.get("daily_units") or {}

        payload: dict[str, Any] = {
            "city": location["name"],
            "weather": self._describe_weather_code(current.get("weather_code")),
            "temperature": self._format_number(current.get("temperature_2m"), current_units.get("temperature_2m", "°C")),
            "source": "Open-Meteo",
            "updatedAt": current.get("time"),
        }

        apparent_temperature = self._format_number(
            current.get("apparent_temperature"),
            current_units.get("apparent_temperature", "°C"),
        )
        if apparent_temperature is not None:
            payload["apparentTemperature"] = apparent_temperature

        wind_speed = self._format_number(
            current.get("wind_speed_10m"),
            current_units.get("wind_speed_10m", "km/h"),
        )
        if wind_speed is not None:
            payload["windSpeed"] = wind_speed

        humidity = current.get("relative_humidity_2m")
        if humidity is not None:
            payload["humidity"] = f"{round(float(humidity))}%"

        max_temperature = self._first_daily_value(daily, "temperature_2m_max")
        if max_temperature is not None:
            payload["todayMaxTemperature"] = self._format_number(
                max_temperature,
                daily_units.get("temperature_2m_max", "°C"),
            )

        min_temperature = self._first_daily_value(daily, "temperature_2m_min")
        if min_temperature is not None:
            payload["todayMinTemperature"] = self._format_number(
                min_temperature,
                daily_units.get("temperature_2m_min", "°C"),
            )

        return payload

    async def _resolve_location(self, city: str) -> dict[str, Any]:
        query = city.strip()
        if not query:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="city is required",
            )

        payload = await self._get_json(
            GEOCODING_URL,
            params={
                "name": query,
                "count": 1,
                "language": "zh",
                "format": "json",
            },
            action="geocode city",
        )
        results = payload.get("results") or []
        if not results:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Weather city not found: {query}",
            )

        top = results[0]
        return {
            "name": top.get("name") or query,
            "latitude": top.get("latitude"),
            "longitude": top.get("longitude"),
        }

    async def _fetch_forecast(self, location: dict[str, Any]) -> dict[str, Any]:
        return await self._get_json(
            FORECAST_URL,
            params={
                "latitude": location["latitude"],
                "longitude": location["longitude"],
                "timezone": "auto",
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                "daily": "temperature_2m_max,temperature_2m_min",
                "forecast_days": 1,
            },
            action="fetch weather forecast",
        )

    async def _get_json(self, url: str, *, params: dict[str, Any], action: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            logger.warning("weather_tool_timeout action=%s params=%s", action, params)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Weather service timeout during {action}",
            ) from exc
        except httpx.HTTPStatusError as exc:
            detail = self._extract_error_detail(exc.response)
            logger.warning(
                "weather_tool_http_error action=%s status=%s detail=%s",
                action,
                exc.response.status_code,
                detail,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Weather service {action} failed: {detail}",
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("weather_tool_network_error action=%s error=%s", action, exc)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Weather service network error during {action}",
            ) from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Weather service returned invalid JSON during {action}",
            ) from exc
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Weather service returned unexpected payload during {action}",
            )
        return payload

    def _extract_error_detail(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return response.text.strip() or response.reason_phrase
        if isinstance(payload, dict):
            return str(payload.get("reason") or payload.get("message") or payload)
        return str(payload)

    def _describe_weather_code(self, code: Any) -> str:
        try:
            normalized = int(code)
        except (TypeError, ValueError):
            return "未知"
        return WMO_WEATHER_CODES.get(normalized, f"天气代码 {normalized}")

    def _format_number(self, value: Any, unit: str) -> str | None:
        if value is None:
            return None
        number = float(value)
        if number.is_integer():
            rendered = str(int(number))
        else:
            rendered = f"{number:.1f}".rstrip("0").rstrip(".")
        return f"{rendered}{unit}"

    def _first_daily_value(self, daily: dict[str, Any], key: str) -> Any:
        values = daily.get(key)
        if isinstance(values, list) and values:
            return values[0]
        return None


weather_service = WeatherService()
