from dataclasses import dataclass

from fastapi import Header, Request


@dataclass
class OpenAIHTTPError(Exception):
    status_code: int
    message: str
    code: str
    error_type: str


def openai_error_payload(message: str, *, code: str, error_type: str) -> dict:
    return {
        "error": {
            "message": message,
            "type": error_type,
            "param": None,
            "code": code,
        }
    }


async def require_api_key(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str:
    expected = request.app.state.settings.AGENT_API_KEY
    if not expected:
        raise OpenAIHTTPError(
            status_code=503,
            message="Agent API key is not configured",
            code="service_unavailable",
            error_type="server_error",
        )

    if not authorization or not authorization.startswith("Bearer "):
        raise OpenAIHTTPError(
            status_code=401,
            message="Missing bearer token",
            code="invalid_api_key",
            error_type="authentication_error",
        )

    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise OpenAIHTTPError(
            status_code=401,
            message="Invalid API key provided",
            code="invalid_api_key",
            error_type="authentication_error",
        )
    return token
