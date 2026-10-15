"""Isolate every pytest entry point before application modules are collected."""
import ipaddress
import logging
import os
from pathlib import Path
import shutil
import socket
import tempfile

import pytest


TEST_RUNTIME = Path(tempfile.mkdtemp(prefix="detachym-pytest-")).resolve()
_environment = pytest.MonkeyPatch()
for name, value in {
    "DETACHYM_ENV_FILE": "",
    "DATABASE_URL": f"sqlite+aiosqlite:///{(TEST_RUNTIME / 'test.db').as_posix()}",
    "CHROMA_PERSIST_DIR": str(TEST_RUNTIME / "chroma"),
    "UPLOAD_DIR": str(TEST_RUNTIME / "uploads"),
    "DOWNLOAD_DIR": str(TEST_RUNTIME / "downloads"),
    "LOG_DIR": str(TEST_RUNTIME / "logs"),
    "DEBUG": "false",
    "SECRET_KEY": "isolated-pytest-key-never-for-deployment",
    "SMTP_USER": "",
    "SMTP_PASSWORD": "",
    "ZHIPU_API_KEY": "",
    "VOLC_AI_RTC_APP_ID": "",
    "VOLC_AI_RTC_APP_KEY": "",
    "VOLC_OPENAPI_AK": "",
    "VOLC_OPENAPI_SK": "",
    "VOLC_AGENT_API_KEY": "",
    "VOLC_AGENT_CHAT_COMPLETIONS_URL": "",
    "VOLC_VOICE_CHAT_ASR_CONFIG_JSON": "{}",
    "VOLC_VOICE_CHAT_TTS_CONFIG_JSON": "{}",
    "VOLC_VOICE_CHAT_LLM_CONFIG_JSON": "{}",
    "BACKEND_INTERNAL_API_KEY": "",
    "REMINDER_EMAIL_WORKER_ENABLED": "false",
    "REMINDER_RECURRENCE_WORKER_ENABLED": "false",
    "ANONYMIZED_TELEMETRY": "false",
    # Disable environment and Windows registry proxies before httpx can route
    # an external URL through an otherwise permitted loopback proxy socket.
    "NO_PROXY": "*",
    "no_proxy": "*",
    "INITIAL_ADMIN_USERNAME": "admin",
    "INITIAL_ADMIN_EMAIL": "admin@example.com",
    "INITIAL_ADMIN_PASSWORD": "ChangeThisPassword123!",
}.items():
    _environment.setenv(name, value)
for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    _environment.delenv(name, raising=False)


def _local_host(host):
    if host is None or host in {"", "localhost", b"localhost"}:
        return True
    try:
        return ipaddress.ip_address(host.decode() if isinstance(host, bytes) else host).is_loopback
    except (ValueError, TypeError):
        return False


_getaddrinfo = socket.getaddrinfo
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex


def _isolated_getaddrinfo(host, *args, **kwargs):
    if not _local_host(host):
        raise AssertionError("External network access is disabled in backend pytest; use a mock transport")
    return _getaddrinfo(host, *args, **kwargs)


def _assert_local_socket(sock, address):
    if sock.family in {socket.AF_INET, socket.AF_INET6}:
        if not isinstance(address, tuple) or not _local_host(address[0]):
            raise AssertionError("External network access is disabled in backend pytest; use a mock transport")


def _isolated_connect(sock, address):
    _assert_local_socket(sock, address)
    return _connect(sock, address)


def _isolated_connect_ex(sock, address):
    _assert_local_socket(sock, address)
    return _connect_ex(sock, address)


_environment.setattr(socket, "getaddrinfo", _isolated_getaddrinfo)
_environment.setattr(socket.socket, "connect", _isolated_connect)
_environment.setattr(socket.socket, "connect_ex", _isolated_connect_ex)

if os.name == "nt":
    from asyncio.windows_events import IocpProactor

    _proactor_connect = IocpProactor.connect

    def _isolated_proactor_connect(proactor, conn, address):
        # Proactor uses Windows ConnectEx directly, bypassing socket.connect.
        _assert_local_socket(conn, address)
        return _proactor_connect(proactor, conn, address)

    _environment.setattr(IocpProactor, "connect", _isolated_proactor_connect)

# Freeze the singleton now: individual test modules and collection order must
# never select the developer's database, dotenv credentials or log directory.
from app.core.config import settings  # noqa: E402

if settings.DATABASE_URL != os.environ["DATABASE_URL"]:
    raise RuntimeError("Application settings were initialized before pytest isolation")


def pytest_report_header():
    return f"Isolated backend runtime: {TEST_RUNTIME}; external network disabled"


def pytest_unconfigure(config):
    _environment.undo()
    # Delete only this invocation's generated directory. Existing .runtime*
    # directories and development/runtime data are deliberately untouched.
    if TEST_RUNTIME.parent != Path(tempfile.gettempdir()).resolve() or not TEST_RUNTIME.name.startswith("detachym-pytest-"):
        return
    loggers = [logging.getLogger(), *logging.Logger.manager.loggerDict.values()]
    for logger in loggers:
        if not isinstance(logger, logging.Logger):
            continue
        for handler in list(logger.handlers):
            if isinstance(handler, logging.FileHandler) and Path(handler.baseFilename).resolve().is_relative_to(TEST_RUNTIME):
                handler.close()
                logger.removeHandler(handler)
    try:
        shutil.rmtree(TEST_RUNTIME)
    except OSError:
        # Windows may still hold Chroma/log handles until process exit.
        reporter = config.pluginmanager.get_plugin("terminalreporter")
        if reporter:
            reporter.write_line(f"Retained isolated test runtime (open file handles): {TEST_RUNTIME}")
