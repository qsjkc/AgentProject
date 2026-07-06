import sys
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.rtc.service import VoiceDemoRtcClient, voice_demo_service
from app.services.rtc.store import VoiceDemoSessionRecord
from app.core.time import utc_now


def make_record(*, pet_type: str = "cat") -> VoiceDemoSessionRecord:
    return VoiceDemoSessionRecord(
        session_id="vs_test",
        owner_user_id=1,
        app_id="app-id",
        room_id="room-id",
        user_id="user-id",
        ai_user_id="BOTUSER123",
        token="token",
        expires_at=utc_now() + timedelta(seconds=60),
        pet_type=pet_type,
    )


def test_rtc_client_normalizes_plain_string_response():
    client = VoiceDemoRtcClient()

    assert client._normalize_response("ok") == {
        "Result": "ok",
        "ResponseMetadata": {},
    }
    assert client._normalize_response('{"Result":"ok","ResponseMetadata":{"RequestId":"1"}}') == {
        "Result": "ok",
        "ResponseMetadata": {"RequestId": "1"},
    }


def test_create_request_accepts_snake_and_camel_pet_type():
    from app.schemas.rtc import VoiceDemoSessionCreateRequest

    assert VoiceDemoSessionCreateRequest.model_validate({"pet_type": "dog"}).pet_type == "dog"
    assert VoiceDemoSessionCreateRequest.model_validate({"petType": "pig"}).pet_type == "pig"
    assert VoiceDemoSessionCreateRequest.model_validate({}).pet_type == "cat"


def test_rtc_client_rejects_local_agent_chat_url(monkeypatch):
    from app.core.config import settings

    client = VoiceDemoRtcClient()
    monkeypatch.setattr(settings, "VOLC_AGENT_CHAT_COMPLETIONS_URL", "http://127.0.0.1:8000/v1/chat/completions")
    monkeypatch.setattr(settings, "VOLC_AGENT_API_KEY", "agent-key")

    with pytest.raises(HTTPException) as exc_info:
        client._build_llm_config(make_record())

    assert exc_info.value.status_code == 503
    assert "localhost or 127.0.0.1" in exc_info.value.detail


def test_rtc_client_accepts_public_agent_chat_url(monkeypatch):
    from app.core.config import settings

    client = VoiceDemoRtcClient()
    monkeypatch.setattr(settings, "VOLC_AGENT_CHAT_COMPLETIONS_URL", "https://detachym.top/agent/v1/chat/completions")
    monkeypatch.setattr(settings, "VOLC_AGENT_API_KEY", "agent-key")
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_LLM_CONFIG_JSON", "{}")

    config = client._build_llm_config(make_record())

    assert config["URL"] == "https://detachym.top/agent/v1/chat/completions"
    assert config["APIKey"] == "agent-key"
    assert any("桌面猫咪伙伴" in message for message in config["SystemMessages"])


def test_rtc_client_adds_pet_persona_to_system_messages(monkeypatch):
    from app.core.config import settings

    client = VoiceDemoRtcClient()
    monkeypatch.setattr(settings, "VOLC_AGENT_CHAT_COMPLETIONS_URL", "https://detachym.top/agent/v1/chat/completions")
    monkeypatch.setattr(settings, "VOLC_AGENT_API_KEY", "agent-key")
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_LLM_CONFIG_JSON", "{}")

    config = client._build_llm_config(make_record(pet_type="dog"))

    assert config["SystemMessages"][0] == settings.VOLC_VOICE_CHAT_SYSTEM_PROMPT
    assert any("桌面狗狗伙伴" in message for message in config["SystemMessages"])


def test_start_body_enables_ai_rts_subtitle(monkeypatch):
    from app.core.config import settings

    client = VoiceDemoRtcClient()
    monkeypatch.setattr(settings, "VOLC_AGENT_CHAT_COMPLETIONS_URL", "https://detachym.top/agent/v1/chat/completions")
    monkeypatch.setattr(settings, "VOLC_AGENT_API_KEY", "agent-key")
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_ASR_CONFIG_JSON", '{"ResourceId":"asr-resource"}')
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_TTS_CONFIG_JSON", '{"ResourceId":"tts-resource"}')
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_LLM_CONFIG_JSON", "{}")
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_ENABLE_RTS_SUBTITLE", True)
    monkeypatch.setattr(settings, "VOLC_VOICE_CHAT_SUBTITLE_MODE", 1)

    body = client._build_start_body(make_record(pet_type="pig"), "task-id")

    assert body["Config"]["SubtitleConfig"] == {
        "DisableRTSSubtitle": False,
        "SubtitleMode": 1,
    }
    assert any("桌面小猪伙伴" in message for message in body["Config"]["LLMConfig"]["SystemMessages"])
    assert "ServerMessageUrl" not in body["Config"]


@pytest.mark.asyncio
async def test_create_session_uses_safe_ai_user_id(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "VOLC_AI_RTC_APP_ID", "app-test-id")
    monkeypatch.setattr(settings, "VOLC_AI_RTC_APP_KEY", "app-test-key")
    monkeypatch.setattr(settings, "VOLC_RTC_TOKEN_TTL_SECONDS", 3600)

    await voice_demo_service.reset_for_tests()
    response = await voice_demo_service.create_session(SimpleNamespace(id=7), pet_type="dog")

    assert response.aiUserId.startswith("BOTUSER")
    assert "_" not in response.aiUserId
    assert response.petType == "dog"


@pytest.mark.asyncio
async def test_rtc_client_uses_raw_json_body_and_parses_reason_dict(monkeypatch):
    client = VoiceDemoRtcClient()

    captured = {}

    fake_sdk = SimpleNamespace(
        UniversalInfo=lambda **kwargs: SimpleNamespace(**kwargs),
    )
    monkeypatch.setitem(sys.modules, "volcenginesdkcore", fake_sdk)

    class FakeApi:
        def do_call(self, info, payload):
            captured["payload"] = payload
            return {"Result": "ok", "ResponseMetadata": {}}

    monkeypatch.setattr(client, "_get_api", lambda: FakeApi())

    body = {"AgentConfig": {"UserId": "BOTUSER123", "TargetUserId": ["user123"]}}
    response = await client._do_call("StartVoiceChat", body)
    assert response["Result"] == "ok"
    assert captured["payload"] == body

    class FakeApiException(Exception):
        def __init__(self):
            self.body = None
            self.reason = {"Code": "NoPermissionForApp", "Message": "appid is not ai agent type"}

    class FailingApi:
        def do_call(self, info, payload):
            raise FakeApiException()

    monkeypatch.setattr(client, "_get_api", lambda: FailingApi())

    with pytest.raises(HTTPException) as exc_info:
        await client._do_call("StartVoiceChat", body)

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "StartVoiceChat failed: NoPermissionForApp appid is not ai agent type"
