"""The local acceptance sink must exercise the actual TLS/auth SMTP sender."""
import importlib.util
import json
from pathlib import Path
import smtplib
from tempfile import TemporaryDirectory

import pytest
from app.core.config import settings
from app.services.email import _send_email_sync


def test_acceptance_sink_receives_actual_tls_authenticated_mime(monkeypatch):
    path = Path(__file__).parents[1] / "scripts" / "acceptance_smtp.py"
    spec = importlib.util.spec_from_file_location("acceptance_smtp_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with TemporaryDirectory(prefix="detachym-e2e-smtp-") as directory:
        runtime = Path(directory)
        sink = module.start_smtp_sink(runtime, "local-acceptance-only")
        try:
            monkeypatch.setattr(settings, "SMTP_SERVER", "127.0.0.1")
            monkeypatch.setattr(settings, "SMTP_PORT", sink.server_address[1])
            monkeypatch.setattr(settings, "SMTP_USER", "acceptance@example.com")
            monkeypatch.setattr(settings, "SMTP_PASSWORD", "local-acceptance-only")
            _send_email_sync("recipient@example.com", "注册验证码", "<p>123456</p>")
            records = json.loads((runtime / "smtp-messages.json").read_text(encoding="utf-8"))
            assert len(records) == 1
            assert records[0]["tls"] and records[0]["authenticated"]
            assert records[0]["recipients"] == ["recipient@example.com"]
            assert records[0]["subject"] == "注册验证码"
            assert "123456" in records[0]["html"]
            with smtplib.SMTP("127.0.0.1", sink.server_address[1], timeout=5) as client:
                client.starttls()
                with pytest.raises(smtplib.SMTPAuthenticationError):
                    client.login("acceptance@example.com", "incorrect-local-password")
            assert len(json.loads((runtime / "smtp-messages.json").read_text(encoding="utf-8"))) == 1
        finally:
            sink.shutdown()
            sink.server_close()
