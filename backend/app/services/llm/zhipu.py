from typing import AsyncGenerator, List, Optional
from contextlib import aclosing
import httpx
import json

from app.services.llm.base import LLMProvider, Message
from app.core.logging import logger


class ZhipuResponseError(RuntimeError):
    """A provider response cannot be used as a completed text answer."""


def invalid_response() -> ZhipuResponseError:
    # Provider bodies may contain private request details. Never put them in
    # exceptions: the chat boundary translates this failure to a public error.
    return ZhipuResponseError("Zhipu returned an incomplete or invalid response")


def response_choice(payload: object, *, allow_usage: bool = False) -> dict | None:
    if not isinstance(payload, dict) or "error" in payload:
        raise invalid_response()
    choices = payload.get("choices")
    if allow_usage and choices == [] and isinstance(payload.get("usage"), dict):
        return None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise invalid_response()
    choice = choices[0]
    reason = choice.get("finish_reason")
    # This adapter does not request or execute tools. Tool calls, truncated
    # answers and provider failures cannot complete this product's text turn.
    if reason is not None and reason != "stop":
        raise invalid_response()
    return choice


async def stream_events(response: httpx.Response):
    data_lines: list[str] = []
    event_type = ""
    async with aclosing(response.aiter_lines()) as lines:
        async for line in lines:
            if line == "":
                if event_type == "error":
                    raise invalid_response()
                if data_lines:
                    yield "\n".join(data_lines)
                data_lines = []
                event_type = ""
            elif line.startswith("data:"):
                value = line[5:]
                data_lines.append(value[1:] if value.startswith(" ") else value)
            elif line.startswith("event:"):
                event_type = line[6:].strip()
    if event_type == "error":
        raise invalid_response()
    if data_lines:
        yield "\n".join(data_lines)


class ZhipuProvider(LLMProvider):
    async def chat(
        self,
        messages: List[Message],
        stream: bool = True,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> AsyncGenerator[str, None]:
        if not stream:
            yield await self.chat_sync(messages, temperature, max_tokens)
            return
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.model,
            "messages": self._convert_messages(messages),
            "temperature": temperature,
            "stream": stream
        }
        
        if max_tokens:
            payload["max_tokens"] = max_tokens
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                url,
                headers=headers,
                json=payload
            ) as response:
                if response.status_code != 200:
                    logger.error("Zhipu API error: HTTP %s", response.status_code)
                    raise invalid_response()

                completed = False
                has_content = False
                async with aclosing(stream_events(response)) as events:
                    async for data in events:
                        if data.strip() == "[DONE]":
                            completed = True
                            break
                        try:
                            payload = json.loads(data)
                        except (json.JSONDecodeError, TypeError) as error:
                            raise invalid_response() from error
                        choice = response_choice(payload, allow_usage=True)
                        if choice is None:
                            continue
                        delta = choice.get("delta", {})
                        if not isinstance(delta, dict):
                            raise invalid_response()
                        content = delta.get("content")
                        if content is not None and not isinstance(content, str):
                            raise invalid_response()
                        if content:
                            has_content = has_content or bool(content.strip())
                            yield content
                if not completed or not has_content:
                    raise invalid_response()
    
    async def chat_sync(
        self,
        messages: List[Message],
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> str:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.model,
            "messages": self._convert_messages(messages),
            "temperature": temperature,
            "stream": False
        }
        
        if max_tokens:
            payload["max_tokens"] = max_tokens
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code != 200:
                logger.error("Zhipu API error: HTTP %s", response.status_code)
                raise invalid_response()

            try:
                data = response.json()
            except (json.JSONDecodeError, TypeError) as error:
                raise invalid_response() from error
            choice = response_choice(data)
            message = choice.get("message")
            if not isinstance(message, dict):
                raise invalid_response()
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                raise invalid_response()
            return content
