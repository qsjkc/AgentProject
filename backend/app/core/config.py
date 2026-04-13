import json
from functools import lru_cache
from typing import List, Optional

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

    APP_NAME: str = "Detachym Platform"
    APP_VERSION: str = "2.0.0"
    DEBUG: bool = False
    SECRET_KEY: str = "change-me-in-production"
    API_PREFIX: str = "/api/v1"

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@postgres:5432/agent_project"

    ZHIPU_API_KEY: Optional[str] = None
    ZHIPU_BASE_URL: str = "https://open.bigmodel.cn/api/paas/v4"
    ZHIPU_MODEL: str = "glm-4-flash"

    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440
    ALGORITHM: str = "HS256"

    CHROMA_PERSIST_DIR: str = "./data/chroma"
    UPLOAD_DIR: str = "./data/uploads"
    DOWNLOAD_DIR: str = "./data/downloads"
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024
    MAX_DOCUMENTS_PER_USER: int = 20
    RAG_TOP_K: int = 4
    CHUNK_SIZE: int = 500
    CHUNK_OVERLAP: int = 50
    EMBEDDING_DIMENSION: int = 128

    SMTP_SERVER: str = "smtp.exmail.qq.com"
    SMTP_PORT: int = 587
    SMTP_USER: Optional[str] = None
    SMTP_PASSWORD: Optional[str] = None
    SMTP_SENDER_NAME: str = "Detachym"

    WEB_APP_URL: str = "http://localhost"
    API_ORIGINS: List[str] = [
        "http://localhost",
        "http://127.0.0.1",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "null",
    ]

    DESKTOP_RELEASE_VERSION: str = "DetachymAgentPet1.0"
    DESKTOP_RELEASE_FILE: str = "DetachymAgentPet1.0.exe"
    DESKTOP_DOWNLOAD_BASE: str = "/download"

    INITIAL_ADMIN_USERNAME: Optional[str] = None
    INITIAL_ADMIN_EMAIL: Optional[str] = None
    INITIAL_ADMIN_PASSWORD: Optional[str] = None

    @field_validator("DEBUG", mode="before")
    @classmethod
    def parse_debug(cls, value: bool | str) -> bool:
        if isinstance(value, bool):
            return value
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "debug", "development"}:
            return True
        if normalized in {"0", "false", "no", "release", "production"}:
            return False
        return False

    @field_validator("API_ORIGINS", mode="before")
    @classmethod
    def parse_api_origins(cls, value: str | List[str]) -> List[str]:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            trimmed = value.strip()
            if not trimmed:
                return []
            if trimmed.startswith("["):
                try:
                    parsed = json.loads(trimmed)
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip().strip('"').strip("'") for item in trimmed.split(",") if item.strip()]
        return []


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
