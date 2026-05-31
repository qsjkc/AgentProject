import asyncio
import json
from copy import deepcopy
from datetime import timedelta
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.config import settings
from app.core.logging import logger
from app.core.time import utc_now
from app.models.user import User
from app.schemas.rtc import (
    VoiceDemoInterruptResponse,
    VoiceDemoSessionCreateResponse,
    VoiceDemoSessionStartResponse,
    VoiceDemoSessionStatusResponse,
    VoiceDemoStopResponse,
)
from app.services.rtc.store import VoiceDemoSessionRecord, VoiceDemoSessionStore, VoiceDemoState
from app.services.rtc.token import generate_rtc_token


FORBIDDEN_VOICE_CONFIG_KEYS = {
    "FunctionCalling",
    "FunctionCallingConfig",
    "FunctionCallConfig",
    "Functions",
    "ServerMessageUrl",
    "ToolChoice",
    "Tools",
}


class VoiceDemoNotFoundError(Exception):
    pass


class VoiceDemoRtcClient:
    def __init__(self) -> None:
        self._api = None

    def _parse_json_object(
        self,
        label: str,
        payload: str,
        *,
        forbidden_keys: set[str] | None = None,
    ) -> dict[str, Any]:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"{label} must be valid JSON",
            ) from exc
        if not isinstance(parsed, dict):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"{label} must decode to a JSON object",
            )
        if forbidden_keys:
            self._reject_forbidden_keys(label, parsed, forbidden_keys)
        return parsed

    def _reject_forbidden_keys(self, label: str, value: Any, forbidden_keys: set[str]) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in forbidden_keys:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"{label} contains unsupported voice-chat key: {key}",
                    )
                self._reject_forbidden_keys(label, child, forbidden_keys)
        elif isinstance(value, list):
            for child in value:
                self._reject_forbidden_keys(label, child, forbidden_keys)

    def _get_api(self):
        if self._api is not None:
            return self._api

        if not settings.VOLC_OPENAPI_AK or not settings.VOLC_OPENAPI_SK:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Volcengine OpenAPI credentials are not configured",
            )

        try:
            import volcenginesdkcore
        except ImportError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Volcengine Python SDK is not installed",
            ) from exc

        configuration = volcenginesdkcore.Configuration()
        configuration.ak = settings.VOLC_OPENAPI_AK
        configuration.sk = settings.VOLC_OPENAPI_SK
        configuration.region = settings.VOLC_OPENAPI_REGION
        configuration.host = "rtc.volcengineapi.com"
        client = volcenginesdkcore.ApiClient(configuration)
        self._api = volcenginesdkcore.UniversalApi(client)
        return self._api

    def _normalize_response(self, response: Any) -> dict[str, Any]:
        if isinstance(response, dict):
            return response
        if isinstance(response, bytes):
            response = response.decode("utf-8", "ignore")
        if isinstance(response, str):
            stripped = response.strip()
            if not stripped:
                return {}
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                return {"Result": stripped, "ResponseMetadata": {}}
            if isinstance(parsed, dict):
                return parsed
            return {"Result": parsed, "ResponseMetadata": {}}
        return {"Result": response, "ResponseMetadata": {}}

    def _translate_api_exception(self, action: str, exc: Exception) -> HTTPException:
        detail = f"{action} failed"
        body = getattr(exc, "body", None)
        reason = getattr(exc, "reason", None)

        if isinstance(body, bytes):
            body = body.decode("utf-8", "ignore")
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                body = body.strip() or None

        if isinstance(body, dict):
            metadata = body.get("ResponseMetadata") or {}
            error = metadata.get("Error") or {}
            code = error.get("Code") or "UpstreamError"
            message = error.get("Message") or str(exc) or "Volcengine API request failed"
            detail = f"{action} failed: {code} {message}"
        elif isinstance(reason, dict):
            code = reason.get("Code") or "UpstreamError"
            message = reason.get("Message") or str(exc) or "Volcengine API request failed"
            detail = f"{action} failed: {code} {message}"
        elif isinstance(body, str):
            detail = f"{action} failed: {body}"
        elif reason:
            detail = f"{action} failed: {reason}"
        elif str(exc):
            detail = f"{action} failed: {exc}"

        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=detail,
        )

    async def _do_call(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        api = self._get_api()
        import volcenginesdkcore

        payload = deepcopy(body)
        info = volcenginesdkcore.UniversalInfo(
            method="POST",
            action=action,
            service="rtc",
            version="2025-06-01",
            content_type="application/json",
        )
        try:
            raw_response = await asyncio.to_thread(api.do_call, info, payload)
        except HTTPException:
            raise
        except Exception as exc:
            raise self._translate_api_exception(action, exc) from exc

        response = self._normalize_response(raw_response)
        metadata = response.get("ResponseMetadata") or {}
        error = metadata.get("Error")
        if error:
            message = error.get("Message") or "Volcengine API request failed"
            code = error.get("Code") or "UnknownError"
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"{action} failed: {code} {message}",
            )
        return response

    def _build_llm_config(self) -> dict[str, Any]:
        if not settings.VOLC_AGENT_CHAT_COMPLETIONS_URL or not settings.VOLC_AGENT_API_KEY:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Agent chat completions URL or API key is not configured",
            )
        config = {
            "Mode": "OpenAI",
            "URL": settings.VOLC_AGENT_CHAT_COMPLETIONS_URL,
            "APIKey": settings.VOLC_AGENT_API_KEY,
            "ModelName": settings.VOLC_AGENT_MODEL_NAME,
            "SystemMessages": [settings.VOLC_VOICE_CHAT_SYSTEM_PROMPT],
            "HistoryLength": 10,
            "ThinkingType": "disabled",
        }
        overrides = self._parse_json_object(
            "VOLC_VOICE_CHAT_LLM_CONFIG_JSON",
            settings.VOLC_VOICE_CHAT_LLM_CONFIG_JSON,
            forbidden_keys=FORBIDDEN_VOICE_CONFIG_KEYS,
        )
        config.update(overrides)
        config.setdefault("Prefill", True)
        self._reject_forbidden_keys("LLMConfig", config, FORBIDDEN_VOICE_CONFIG_KEYS)
        return config

    def _build_asr_config(self) -> dict[str, Any]:
        asr_config = self._parse_json_object(
            "VOLC_VOICE_CHAT_ASR_CONFIG_JSON",
            settings.VOLC_VOICE_CHAT_ASR_CONFIG_JSON,
            forbidden_keys=FORBIDDEN_VOICE_CONFIG_KEYS,
        )
        asr_config.setdefault("TurnDetectionMode", 0)
        vad_config = asr_config.setdefault("VADConfig", {})
        if not isinstance(vad_config, dict):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="VOLC_VOICE_CHAT_ASR_CONFIG_JSON.VADConfig must be a JSON object",
            )
        vad_config.setdefault("SilenceTime", 800)
        vad_config.setdefault("AIVAD", True)
        vad_config.setdefault("ForceBeginThreshold", 200)
        return asr_config

    def _build_start_body(self, record: VoiceDemoSessionRecord, task_id: str) -> dict[str, Any]:
        asr_config = self._build_asr_config()
        tts_config = self._parse_json_object(
            "VOLC_VOICE_CHAT_TTS_CONFIG_JSON",
            settings.VOLC_VOICE_CHAT_TTS_CONFIG_JSON,
            forbidden_keys=FORBIDDEN_VOICE_CONFIG_KEYS,
        )
        if not asr_config or not tts_config:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ASR and TTS configs must be provided before starting voice chat",
            )
        return {
            "AppId": record.app_id,
            "RoomId": record.room_id,
            "TaskId": task_id,
            "AgentConfig": {
                "UserId": record.ai_user_id,
                "TargetUserId": [record.user_id],
                "WelcomeMessage": settings.VOLC_VOICE_CHAT_WELCOME_MESSAGE,
            },
            "Config": {
                "InterruptMode": 0,
                "ASRConfig": asr_config,
                "LLMConfig": self._build_llm_config(),
                "TTSConfig": tts_config,
            },
        }

    async def start_voice_chat(self, record: VoiceDemoSessionRecord, task_id: str) -> dict[str, Any]:
        body = self._build_start_body(record, task_id)
        return await self._do_call("StartVoiceChat", body)

    async def update_voice_chat_interrupt(self, record: VoiceDemoSessionRecord) -> dict[str, Any]:
        if not record.task_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Voice chat task has not started",
            )
        return await self._do_call(
            "UpdateVoiceChat",
            {
                "AppId": record.app_id,
                "RoomId": record.room_id,
                "TaskId": record.task_id,
                "Command": "interrupt",
            },
        )

    async def stop_voice_chat(self, record: VoiceDemoSessionRecord) -> dict[str, Any]:
        if not record.task_id:
            return {"Result": "ok"}
        return await self._do_call(
            "StopVoiceChat",
            {
                "AppId": record.app_id,
                "RoomId": record.room_id,
                "TaskId": record.task_id,
            },
        )


class VoiceDemoService:
    def __init__(self) -> None:
        self._store = VoiceDemoSessionStore()
        self._client = VoiceDemoRtcClient()
        self._cleanup_task: asyncio.Task | None = None
        self._shutdown = asyncio.Event()

    async def startup(self) -> None:
        if self._cleanup_task and not self._cleanup_task.done():
            return
        self._shutdown = asyncio.Event()
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def shutdown(self) -> None:
        self._shutdown.set()
        if not self._cleanup_task:
            return
        try:
            await asyncio.wait_for(self._cleanup_task, timeout=5)
        except asyncio.TimeoutError:
            logger.warning("voice_demo.cleanup_shutdown_timeout")
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        except asyncio.CancelledError:
            pass
        finally:
            self._cleanup_task = None

    async def reset_for_tests(self) -> None:
        await self._store.reset()

    def _session_status_response(self, record: VoiceDemoSessionRecord) -> VoiceDemoSessionStatusResponse:
        return VoiceDemoSessionStatusResponse(
            sessionId=record.session_id,
            roomId=record.room_id,
            sessionActive=record.session_active,
            state=record.state.value,
            startedAt=record.started_at,
            expiresAt=record.expires_at,
            lastAction=record.last_action,
            lastError=record.last_error,
        )

    def _start_response(self, record: VoiceDemoSessionRecord, *, started: bool) -> VoiceDemoSessionStartResponse:
        return VoiceDemoSessionStartResponse(
            started=started,
            sessionActive=record.session_active,
            state=record.state.value,
            lastAction=record.last_action,
            lastError=record.last_error,
        )

    def _interrupt_response(self, record: VoiceDemoSessionRecord, *, accepted: bool) -> VoiceDemoInterruptResponse:
        return VoiceDemoInterruptResponse(
            accepted=accepted,
            sessionActive=record.session_active,
            state=record.state.value,
            lastAction=record.last_action,
            lastError=record.last_error,
        )

    def _stop_response(
        self,
        record: VoiceDemoSessionRecord,
        *,
        already_stopped: bool,
        cleanup_pending: bool,
    ) -> VoiceDemoStopResponse:
        return VoiceDemoStopResponse(
            success=True,
            alreadyStopped=already_stopped,
            cleanupPending=cleanup_pending,
            sessionActive=record.session_active,
            state=record.state.value,
            lastAction=record.last_action,
            lastError=record.last_error,
        )

    def missing_stop_response(self) -> VoiceDemoStopResponse:
        return VoiceDemoStopResponse(
            success=True,
            alreadyStopped=True,
            cleanupPending=False,
            sessionActive=False,
            state=VoiceDemoState.STOPPED.value,
            lastAction="stop",
            lastError=None,
        )

    def missing_interrupt_response(self) -> VoiceDemoInterruptResponse:
        return VoiceDemoInterruptResponse(
            accepted=False,
            sessionActive=False,
            state=VoiceDemoState.STOPPED.value,
            lastAction="interrupt",
            lastError="session not active or already cleaned up",
        )

    def _exception_detail(self, exc: Exception) -> str:
        if isinstance(exc, HTTPException):
            return str(exc.detail)
        return str(exc) or exc.__class__.__name__

    def _desired_terminal_state(self, record: VoiceDemoSessionRecord, fallback: VoiceDemoState) -> VoiceDemoState:
        if record.expires_at <= utc_now():
            return VoiceDemoState.EXPIRED
        return record.terminal_state or fallback

    async def _get_owned_record(self, owner_user_id: int, session_id: str) -> VoiceDemoSessionRecord:
        record = await self._store.get_owned(session_id, owner_user_id)
        if not record:
            raise VoiceDemoNotFoundError("Voice demo session not found")
        if record.state == VoiceDemoState.ACTIVE and record.expires_at <= utc_now():
            record, _ = await self._stop_remote_and_update(
                record,
                desired_state=VoiceDemoState.EXPIRED,
                last_action="expire",
                failure_state=VoiceDemoState.STOP_PENDING,
            )
        return record

    async def _mark_terminal(
        self,
        record: VoiceDemoSessionRecord,
        *,
        state: VoiceDemoState,
        last_action: str,
        terminal_state: VoiceDemoState,
        last_error: str | None = None,
    ) -> VoiceDemoSessionRecord:
        tombstone_until = utc_now() + timedelta(seconds=settings.VOLC_SESSION_TOMBSTONE_SECONDS)
        updated = await self._store.update(
            record.session_id,
            state=state,
            last_action=last_action,
            last_error=last_error,
            terminal_state=terminal_state,
            tombstone_until=tombstone_until,
        )
        if updated is None:
            raise VoiceDemoNotFoundError("Voice demo session not found")
        return updated

    async def _mark_retryable_stop_failure(
        self,
        record: VoiceDemoSessionRecord,
        *,
        desired_state: VoiceDemoState,
        last_action: str,
        failure_state: VoiceDemoState,
        error: str,
    ) -> VoiceDemoSessionRecord:
        updated = await self._store.update(
            record.session_id,
            state=failure_state,
            last_action=last_action,
            last_error=error,
            terminal_state=desired_state,
            cleanup_attempts=record.cleanup_attempts + 1,
        )
        if updated is None:
            raise VoiceDemoNotFoundError("Voice demo session not found")
        return updated

    async def _stop_remote_and_update(
        self,
        record: VoiceDemoSessionRecord,
        *,
        desired_state: VoiceDemoState,
        last_action: str,
        failure_state: VoiceDemoState,
    ) -> tuple[VoiceDemoSessionRecord, bool]:
        if not record.task_id:
            terminal = await self._mark_terminal(
                record,
                state=desired_state,
                last_action=last_action,
                terminal_state=desired_state,
            )
            return terminal, False

        try:
            await self._client.stop_voice_chat(record)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            detail = self._exception_detail(exc)
            logger.warning(
                "voice_demo.stop_retryable_failure session_id=%s room_id=%s task_id=%s error=%s",
                record.session_id,
                record.room_id,
                record.task_id,
                detail,
            )
            pending = await self._mark_retryable_stop_failure(
                record,
                desired_state=desired_state,
                last_action=last_action,
                failure_state=failure_state,
                error=detail,
            )
            return pending, True

        terminal = await self._mark_terminal(
            record,
            state=desired_state,
            last_action=last_action,
            terminal_state=desired_state,
        )
        return terminal, False

    async def create_session(self, current_user: User) -> VoiceDemoSessionCreateResponse:
        if not settings.VOLC_AI_RTC_APP_ID or not settings.VOLC_AI_RTC_APP_KEY:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="RTC AppId/AppKey is not configured",
            )

        session_uuid = uuid4().hex
        session_id = f"vs_{session_uuid}"
        room_id = f"voice_demo_room_{session_uuid[:12]}"
        user_id = f"user_{current_user.id}_{session_uuid[:8]}"
        ai_user_id = f"BotUser{session_uuid[:10]}".upper()
        expire_at = utc_now() + timedelta(seconds=settings.VOLC_RTC_TOKEN_TTL_SECONDS)
        token = generate_rtc_token(
            app_id=settings.VOLC_AI_RTC_APP_ID,
            app_key=settings.VOLC_AI_RTC_APP_KEY,
            room_id=room_id,
            user_id=user_id,
            expire_at=int(expire_at.timestamp()),
        )
        record = VoiceDemoSessionRecord(
            session_id=session_id,
            owner_user_id=current_user.id,
            app_id=settings.VOLC_AI_RTC_APP_ID,
            room_id=room_id,
            user_id=user_id,
            ai_user_id=ai_user_id,
            token=token,
            expires_at=expire_at,
        )
        await self._store.create(record)
        logger.info(
            "voice_demo.create session_id=%s room_id=%s user_id=%s",
            record.session_id,
            record.room_id,
            record.user_id,
        )
        return VoiceDemoSessionCreateResponse(
            sessionId=record.session_id,
            appId=record.app_id,
            roomId=record.room_id,
            userId=record.user_id,
            aiUserId=record.ai_user_id,
            token=record.token,
            sessionActive=record.session_active,
            state=record.state.value,
            expiresAt=record.expires_at,
        )

    async def start_session(self, current_user: User, session_id: str) -> VoiceDemoSessionStartResponse:
        record = await self._get_owned_record(current_user.id, session_id)
        if record.state == VoiceDemoState.ACTIVE:
            return self._start_response(record, started=True)
        if record.state == VoiceDemoState.CREATING and record.task_id:
            return self._start_response(record, started=False)
        if record.state in {
            VoiceDemoState.STOPPING,
            VoiceDemoState.STOPPED,
            VoiceDemoState.STOP_PENDING,
            VoiceDemoState.CLEANUP_FAILED,
            VoiceDemoState.EXPIRED,
            VoiceDemoState.FAILED,
        }:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Session is not startable in state {record.state.value}",
            )

        task_id = f"task_{uuid4().hex}"
        request_id = uuid4().hex
        record = await self._store.update(
            record.session_id,
            state=VoiceDemoState.CREATING,
            last_action="start",
            last_error=None,
            task_id=task_id,
            terminal_state=None,
        )
        assert record is not None
        logger.info(
            "voice_demo.start request_id=%s session_id=%s room_id=%s task_id=%s",
            request_id,
            record.session_id,
            record.room_id,
            task_id,
        )
        try:
            await self._client.start_voice_chat(record, task_id)
        except HTTPException as exc:
            await self._mark_terminal(
                record,
                state=VoiceDemoState.FAILED,
                last_action="start",
                terminal_state=VoiceDemoState.FAILED,
                last_error=str(exc.detail),
            )
            raise HTTPException(status_code=exc.status_code, detail=str(exc.detail)) from exc

        latest = await self._store.get(record.session_id)
        if latest and latest.state in {
            VoiceDemoState.STOPPING,
            VoiceDemoState.STOP_PENDING,
            VoiceDemoState.CLEANUP_FAILED,
            VoiceDemoState.STOPPED,
            VoiceDemoState.EXPIRED,
        }:
            stopped, _ = await self._stop_remote_and_update(
                latest,
                desired_state=self._desired_terminal_state(latest, VoiceDemoState.STOPPED),
                last_action=latest.last_action or "stop",
                failure_state=VoiceDemoState.STOP_PENDING,
            )
            return self._start_response(stopped, started=False)

        updated = await self._store.update(
            record.session_id,
            state=VoiceDemoState.ACTIVE,
            started_at=utc_now(),
            last_action="start",
            last_error=None,
            terminal_state=None,
        )
        assert updated is not None
        return self._start_response(updated, started=True)

    async def get_session_status(self, current_user: User, session_id: str) -> VoiceDemoSessionStatusResponse:
        record = await self._get_owned_record(current_user.id, session_id)
        return self._session_status_response(record)

    async def interrupt_session(
        self,
        current_user: User,
        session_id: str,
    ) -> VoiceDemoInterruptResponse:
        record = await self._get_owned_record(current_user.id, session_id)
        if record.state != VoiceDemoState.ACTIVE or not record.task_id:
            return self._interrupt_response(record, accepted=False)

        request_id = uuid4().hex
        logger.info(
            "voice_demo.interrupt request_id=%s session_id=%s room_id=%s task_id=%s",
            request_id,
            record.session_id,
            record.room_id,
            record.task_id,
        )
        try:
            await self._client.update_voice_chat_interrupt(record)
        except HTTPException as exc:
            updated = await self._store.update(
                record.session_id,
                last_error=str(exc.detail),
            )
            assert updated is not None
            raise

        updated = await self._store.update(
            record.session_id,
            last_action="interrupt",
            last_error=None,
        )
        assert updated is not None
        return self._interrupt_response(updated, accepted=True)

    async def stop_session(self, current_user: User, session_id: str) -> VoiceDemoStopResponse:
        record = await self._get_owned_record(current_user.id, session_id)
        if record.state in {VoiceDemoState.STOPPED, VoiceDemoState.EXPIRED}:
            return self._stop_response(record, already_stopped=True, cleanup_pending=False)
        if record.state in {VoiceDemoState.STOPPING, VoiceDemoState.STOP_PENDING, VoiceDemoState.CLEANUP_FAILED}:
            return self._stop_response(record, already_stopped=False, cleanup_pending=True)
        if record.state == VoiceDemoState.FAILED or not record.task_id:
            updated = await self._mark_terminal(
                record,
                state=VoiceDemoState.STOPPED,
                last_action="stop",
                terminal_state=VoiceDemoState.STOPPED,
            )
            return self._stop_response(updated, already_stopped=False, cleanup_pending=False)

        request_id = uuid4().hex
        logger.info(
            "voice_demo.stop request_id=%s session_id=%s room_id=%s task_id=%s",
            request_id,
            record.session_id,
            record.room_id,
            record.task_id,
        )
        stopping = await self._store.update(
            record.session_id,
            state=VoiceDemoState.STOPPING,
            last_action="stop",
            last_error=None,
            terminal_state=self._desired_terminal_state(record, VoiceDemoState.STOPPED),
        )
        assert stopping is not None
        updated, cleanup_pending = await self._stop_remote_and_update(
            stopping,
            desired_state=self._desired_terminal_state(record, VoiceDemoState.STOPPED),
            last_action="stop",
            failure_state=VoiceDemoState.STOP_PENDING,
        )
        return self._stop_response(
            updated,
            already_stopped=False,
            cleanup_pending=cleanup_pending,
        )

    async def _cleanup_loop(self) -> None:
        interval = max(5, settings.VOLC_SESSION_CLEANUP_INTERVAL_SECONDS)
        while not self._shutdown.is_set():
            try:
                await self._run_cleanup_pass()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("voice_demo.cleanup_loop_error")

            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue

    async def _run_cleanup_pass(self) -> None:
        candidates = await self._store.list_cleanup_candidates()
        for record in candidates:
            try:
                desired_state = self._desired_terminal_state(record, VoiceDemoState.STOPPED)
                failure_state = (
                    VoiceDemoState.STOP_PENDING
                    if record.state == VoiceDemoState.ACTIVE
                    else VoiceDemoState.CLEANUP_FAILED
                )
                await self._stop_remote_and_update(
                    record,
                    desired_state=desired_state,
                    last_action="expire" if desired_state == VoiceDemoState.EXPIRED else "stop",
                    failure_state=failure_state,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "voice_demo.cleanup_candidate_error session_id=%s room_id=%s task_id=%s",
                    record.session_id,
                    record.room_id,
                    record.task_id,
                )
        await self._store.prune()


voice_demo_service = VoiceDemoService()
