from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import get_current_user
from app.models.user import User
from app.schemas.rtc import (
    VoiceDemoInterruptResponse,
    VoiceDemoSessionCreateResponse,
    VoiceDemoSessionStartResponse,
    VoiceDemoSessionStatusResponse,
    VoiceDemoStopResponse,
)
from app.services.rtc.service import VoiceDemoNotFoundError, voice_demo_service

router = APIRouter(prefix="/rtc/voice-demo", tags=["rtc"])


def _translate_not_found(exc: VoiceDemoNotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.post("/session", response_model=VoiceDemoSessionCreateResponse)
async def create_session(
    current_user: User = Depends(get_current_user),
) -> VoiceDemoSessionCreateResponse:
    return await voice_demo_service.create_session(current_user)


@router.post("/session/{session_id}/start", response_model=VoiceDemoSessionStartResponse)
async def start_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> VoiceDemoSessionStartResponse:
    try:
        return await voice_demo_service.start_session(current_user, session_id)
    except VoiceDemoNotFoundError as exc:
        raise _translate_not_found(exc) from exc


@router.get("/session/{session_id}", response_model=VoiceDemoSessionStatusResponse)
async def get_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> VoiceDemoSessionStatusResponse:
    try:
        return await voice_demo_service.get_session_status(current_user, session_id)
    except VoiceDemoNotFoundError as exc:
        raise _translate_not_found(exc) from exc


@router.post("/session/{session_id}/interrupt", response_model=VoiceDemoInterruptResponse)
async def interrupt_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> VoiceDemoInterruptResponse:
    try:
        return await voice_demo_service.interrupt_session(current_user, session_id)
    except VoiceDemoNotFoundError:
        return voice_demo_service.missing_interrupt_response()


@router.post("/session/{session_id}/stop", response_model=VoiceDemoStopResponse)
async def stop_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> VoiceDemoStopResponse:
    try:
        return await voice_demo_service.stop_session(current_user, session_id)
    except VoiceDemoNotFoundError:
        return voice_demo_service.missing_stop_response()
