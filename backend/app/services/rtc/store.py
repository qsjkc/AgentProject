import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from app.core.time import utc_now


class VoiceDemoState(StrEnum):
    CREATING = "creating"
    ACTIVE = "active"
    STOPPING = "stopping"
    STOPPED = "stopped"
    EXPIRED = "expired"
    STOP_PENDING = "stop_pending"
    CLEANUP_FAILED = "cleanup_failed"
    FAILED = "failed"


@dataclass
class VoiceDemoSessionRecord:
    session_id: str
    owner_user_id: int
    app_id: str
    room_id: str
    user_id: str
    ai_user_id: str
    token: str
    expires_at: datetime
    state: VoiceDemoState = VoiceDemoState.CREATING
    task_id: str | None = None
    started_at: datetime | None = None
    last_action: str | None = None
    last_error: str | None = None
    cleanup_attempts: int = 0
    tombstone_until: datetime | None = None
    terminal_state: VoiceDemoState | None = None

    @property
    def session_active(self) -> bool:
        return self.state == VoiceDemoState.ACTIVE and self.expires_at > utc_now()


class VoiceDemoSessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, VoiceDemoSessionRecord] = {}
        self._lock = asyncio.Lock()

    async def create(self, record: VoiceDemoSessionRecord) -> VoiceDemoSessionRecord:
        async with self._lock:
            self._sessions[record.session_id] = record
            return deepcopy(record)

    async def get(self, session_id: str) -> VoiceDemoSessionRecord | None:
        async with self._lock:
            record = self._sessions.get(session_id)
            return deepcopy(record) if record else None

    async def get_owned(self, session_id: str, owner_user_id: int) -> VoiceDemoSessionRecord | None:
        async with self._lock:
            record = self._sessions.get(session_id)
            if not record or record.owner_user_id != owner_user_id:
                return None
            return deepcopy(record)

    async def update(self, session_id: str, **fields) -> VoiceDemoSessionRecord | None:
        async with self._lock:
            record = self._sessions.get(session_id)
            if not record:
                return None
            for key, value in fields.items():
                setattr(record, key, value)
            return deepcopy(record)

    async def list_cleanup_candidates(self) -> list[VoiceDemoSessionRecord]:
        now = utc_now()
        async with self._lock:
            items = []
            for record in self._sessions.values():
                if record.state == VoiceDemoState.ACTIVE and record.expires_at <= now:
                    items.append(deepcopy(record))
                    continue
                if record.state in {
                    VoiceDemoState.STOPPING,
                    VoiceDemoState.STOP_PENDING,
                    VoiceDemoState.CLEANUP_FAILED,
                }:
                    items.append(deepcopy(record))
            return items

    async def prune(self) -> None:
        now = utc_now()
        async with self._lock:
            stale = [
                session_id
                for session_id, record in self._sessions.items()
                if record.tombstone_until and record.tombstone_until <= now
            ]
            for session_id in stale:
                self._sessions.pop(session_id, None)

    async def reset(self) -> None:
        async with self._lock:
            self._sessions.clear()
