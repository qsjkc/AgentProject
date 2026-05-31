from datetime import datetime
from typing import Literal

from pydantic import BaseModel


VoiceDemoState = Literal[
    "creating",
    "active",
    "stopping",
    "stopped",
    "expired",
    "stop_pending",
    "cleanup_failed",
    "failed",
]


class VoiceDemoSessionCreateResponse(BaseModel):
    sessionId: str
    appId: str
    roomId: str
    userId: str
    aiUserId: str
    token: str
    sessionActive: bool
    state: VoiceDemoState
    expiresAt: datetime


class VoiceDemoSessionStatusResponse(BaseModel):
    sessionId: str
    roomId: str
    sessionActive: bool
    state: VoiceDemoState
    startedAt: datetime | None
    expiresAt: datetime
    lastAction: str | None
    lastError: str | None


class VoiceDemoSessionStartResponse(BaseModel):
    started: bool
    sessionActive: bool
    state: VoiceDemoState
    lastAction: str | None
    lastError: str | None


class VoiceDemoInterruptResponse(BaseModel):
    accepted: bool
    sessionActive: bool
    state: VoiceDemoState
    lastAction: str | None
    lastError: str | None


class VoiceDemoStopResponse(BaseModel):
    success: bool
    alreadyStopped: bool
    cleanupPending: bool
    sessionActive: bool
    state: VoiceDemoState
    lastAction: str | None
    lastError: str | None
