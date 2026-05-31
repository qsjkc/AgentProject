from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

    AGENT_API_KEY: str = ""
    AGENT_LOG_LEVEL: str = "info"
    AGENT_FIRST_CHUNK_TIMEOUT_MS: int = 8000
    AGENT_TOTAL_TIMEOUT_MS: int = 45000
    AGENT_TOOL_TIMEOUT_MS: int = 5000
    BACKEND_BASE_URL: str = "http://localhost:5000"
    BACKEND_INTERNAL_API_KEY: str | None = None
    AGENT_MODEL_NAME: str = "voice-agent-demo-v1"

    @field_validator(
        "AGENT_FIRST_CHUNK_TIMEOUT_MS",
        "AGENT_TOTAL_TIMEOUT_MS",
        "AGENT_TOOL_TIMEOUT_MS",
        mode="before",
    )
    @classmethod
    def validate_positive_timeout(cls, value: int | str) -> int:
        parsed = int(value)
        if parsed <= 0:
            raise ValueError("timeout values must be positive")
        return parsed

    @field_validator("BACKEND_BASE_URL", mode="before")
    @classmethod
    def normalize_backend_base_url(cls, value: str) -> str:
        trimmed = str(value).strip()
        if not trimmed:
            raise ValueError("BACKEND_BASE_URL is required")
        return trimmed.rstrip("/")

    @property
    def first_chunk_timeout_seconds(self) -> float:
        return self.AGENT_FIRST_CHUNK_TIMEOUT_MS / 1000

    @property
    def total_timeout_seconds(self) -> float:
        return self.AGENT_TOTAL_TIMEOUT_MS / 1000

    @property
    def tool_timeout_seconds(self) -> float:
        return self.AGENT_TOOL_TIMEOUT_MS / 1000


@lru_cache()
def get_settings() -> Settings:
    return Settings()
