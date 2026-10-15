from pathlib import Path
import asyncio
import os
import socket
import tempfile

from httpx._utils import get_environment_proxies

import pytest

from app.core.config import Settings, settings
from app.core.logging import LOG_DIR


def test_storage_and_configuration_are_isolated_before_collection():
    database_path = Path(settings.DATABASE_URL.removeprefix("sqlite+aiosqlite:///")).resolve()
    runtime = database_path.parent
    assert runtime.parent == Path(tempfile.gettempdir()).resolve()
    assert runtime.name.startswith("detachym-pytest-")
    for configured in [settings.CHROMA_PERSIST_DIR, settings.UPLOAD_DIR, settings.DOWNLOAD_DIR, LOG_DIR]:
        assert Path(configured).resolve().parent == runtime
    assert Settings.model_config["env_file"] is None
    assert not any([
        settings.SMTP_USER, settings.SMTP_PASSWORD, settings.ZHIPU_API_KEY,
        settings.VOLC_AI_RTC_APP_KEY, settings.VOLC_OPENAPI_AK,
        settings.VOLC_OPENAPI_SK, settings.VOLC_AGENT_API_KEY,
    ])
    assert not settings.REMINDER_EMAIL_WORKER_ENABLED
    assert not settings.REMINDER_RECURRENCE_WORKER_ENABLED


def test_real_external_network_is_rejected_before_connecting():
    assert get_environment_proxies() == {}
    with pytest.raises(AssertionError, match="External network access is disabled"):
        socket.getaddrinfo("example.invalid", 443)
    with socket.socket() as connection:
        with pytest.raises(AssertionError, match="External network access is disabled"):
            connection.connect(("192.0.2.1", 443))
        with pytest.raises(AssertionError, match="External network access is disabled"):
            connection.connect_ex(("192.0.2.1", 443))


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "nt", reason="Windows Proactor connection path")
async def test_windows_async_numeric_ip_cannot_bypass_isolation(monkeypatch):
    from asyncio.windows_events import IocpProactor
    import conftest

    assert IocpProactor.connect is conftest._isolated_proactor_connect

    def must_not_connect(*_args):
        pytest.fail("The operating-system connection must not be reached")

    monkeypatch.setattr(conftest, "_proactor_connect", must_not_connect)
    with socket.socket() as connection:
        connection.setblocking(False)
        with pytest.raises(AssertionError, match="External network access is disabled"):
            await asyncio.get_running_loop().sock_connect(connection, ("192.0.2.1", 443))
