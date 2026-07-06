# Desktop Pet Interaction Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first desktop-only vertical slice for a living pet experience: one fully animated pig pet, pet-owned one-time reminders synced through the backend, and desktop reminder feedback driven by the current active pet.

**Architecture:** Keep RTC untouched and out of scope. Add backend reminder persistence under `userId + petType`, then let the Electron desktop client parse reminder intent, create synced reminders, poll only the current pet's pending reminders, and drive a focused pet animation state machine. Implement pig first as the complete slice, then reuse the same asset and state-machine contract for cat and dog.

**Tech Stack:** FastAPI, SQLAlchemy async, Pydantic, SQLite/Alembic, Electron, React, Vite, electron-store, transparent PNG animation frames.

---

## Scope

### In Scope

- Desktop client only: `desktop/`.
- Backend reminder API and persistence: `backend/`.
- Pig vertical slice first.
- Pig actions: `idle`, `walk`, `jump`, `happy`, `confused`, `reminding`, `sleeping`.
- Standard frame count: 6-8 PNG frames per action; `idle` and `sleeping` can use 4-6 frames.
- One-time reminders only.
- Reminder ownership is `user_id + pet_type`.
- Only the current active pet's reminders trigger in the desktop client.
- Switching pet shows one warning when the current pet has pending reminders.
- RTC code remains present and is not part of validation.

### Out Of Scope

- Browser extension.
- RTC renewal, removal, or refactor.
- Repeating reminders.
- Email reminders.
- Multi-channel reminder rules beyond desktop bubble and system notification.
- Long-term memory or relationship growth.
- Multiple pets on screen at once.
- Live2D, Spine, or skeletal animation.

## Existing Context

- `desktop/src/pet.jsx` currently renders one image from `getPetVisual(petType, mood)`.
- `desktop/src/shared/pets.js` currently maps `cat|dog|pig` and `idle|happy|excited|sad` to static PNGs under `frontend/src/assets/pets/`.
- `desktop/src/main-panel.jsx` already switches pet preference through `desktopApi.updatePreferences()` and `window.desktopBridge.switchPetFromMainPanel()`.
- `desktop/src/quick-chat.jsx` sends text messages through `desktopApi.sendMessage()`.
- `desktop/electron/main.cjs` already exposes notification IPC through `desktop:show-notification`.
- `backend/app/models/database.py` owns SQLAlchemy models and SQLite bootstrap compatibility.
- `backend/app/api/router.py` includes versioned routers under `/api/v1`.

## File Structure

### Backend

- Create: `backend/app/schemas/reminder.py`
  - Pydantic request and response models for one-time reminders.
- Create: `backend/app/api/v1/reminders.py`
  - Authenticated reminder CRUD and pending summary endpoints.
- Modify: `backend/app/models/database.py`
  - Add `Reminder` model, user relationship, and SQLite bootstrap table creation support.
- Modify: `backend/app/models/user.py`
  - Export `Reminder`.
- Modify: `backend/app/api/router.py`
  - Include `reminders.router`.
- Create: `backend/alembic/versions/003_pet_reminders.py`
  - Migration for non-SQLite managed deployments.
- Create: `backend/tests/test_reminders.py`
  - Auth, ownership, pet isolation, complete/cancel, and pending summary tests.

### Desktop

- Create: `desktop/src/shared/pet-animation-config.js`
  - Animation asset registry and fallback rules.
- Create: `desktop/src/shared/pet-animation-state.js`
  - Pure reducer/state machine for animation priority.
- Create: `desktop/src/shared/reminder-parser.js`
  - Chinese one-time reminder parser for first-version supported expressions.
- Create: `desktop/src/shared/reminders-api.js`
  - Desktop API wrapper for reminder endpoints.
- Create: `desktop/src/shared/pet-personality.js`
  - Animal-specific copy and reminder style.
- Create: `desktop/src/components/PetAnimator.jsx`
  - Render frames from an animation config.
- Modify: `desktop/src/pet.jsx`
  - Replace static image mood rendering with animation state, reminder polling, and reminder feedback.
- Modify: `desktop/src/main-panel.jsx`
  - Intercept reminder intent in text input and warn on pet switch when current pet has pending reminders.
- Modify: `desktop/src/quick-chat.jsx`
  - Intercept reminder intent before sending normal chat.
- Modify: `desktop/electron/main.cjs`
  - Add IPC event relay from main panel / quick chat to pet window.
- Modify: `desktop/electron/preload.cjs`
  - Expose reminder event relay methods.
- Modify: `desktop/scripts/test.mjs`
  - Add pure tests for parser and animation state reducer.

### Assets

- Create directories:
  - `frontend/src/assets/pets/pig/animations/idle/`
  - `frontend/src/assets/pets/pig/animations/walk/`
  - `frontend/src/assets/pets/pig/animations/jump/`
  - `frontend/src/assets/pets/pig/animations/happy/`
  - `frontend/src/assets/pets/pig/animations/confused/`
  - `frontend/src/assets/pets/pig/animations/reminding/`
  - `frontend/src/assets/pets/pig/animations/sleeping/`
- Add PNG frames:
  - `frame-01.png`
  - `frame-02.png`
  - `frame-03.png`
  - `frame-04.png`
  - `frame-05.png`
  - `frame-06.png`
  - Optional per action: `frame-07.png`, `frame-08.png`

All frames must be transparent PNG, visually aligned to the current pig style, and export at one consistent canvas size.

---

## Task 1: Backend Reminder Model And Schemas

**Files:**
- Modify: `backend/app/models/database.py`
- Modify: `backend/app/models/user.py`
- Create: `backend/app/schemas/reminder.py`
- Create: `backend/alembic/versions/003_pet_reminders.py`
- Test later in: `backend/tests/test_reminders.py`

- [ ] **Step 1: Add the Reminder model**

Add `Reminder` in `backend/app/models/database.py` near the other business models.

```python
class Reminder(Base):
    __tablename__ = "reminders"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pet_type = Column(String(20), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    source_text = Column(Text, nullable=True)
    remind_at = Column(DateTime, nullable=False, index=True)
    status = Column(String(20), nullable=False, default="pending", index=True)
    triggered_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", back_populates="reminders")
```

Add this relationship to `User`:

```python
reminders = relationship("Reminder", back_populates="user", cascade="all, delete-orphan")
```

- [ ] **Step 2: Include reminders in legacy table detection**

In `backend/app/models/database.py`, add `"reminders"` to `LEGACY_APP_TABLES`.

```python
LEGACY_APP_TABLES = {
    "users",
    "user_preferences",
    "verification_codes",
    "chat_sessions",
    "chat_messages",
    "documents",
    "reminders",
}
```

SQLite uses `Base.metadata.create_all`, so no manual `ALTER TABLE` is needed for a new table.

- [ ] **Step 3: Export Reminder**

In `backend/app/models/user.py`:

```python
from app.models.database import Reminder, User, UserPreference, VerificationCode


__all__ = ["User", "UserPreference", "VerificationCode", "Reminder"]
```

- [ ] **Step 4: Create reminder schemas**

Create `backend/app/schemas/reminder.py`.

```python
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

PetType = Literal["cat", "dog", "pig"]
ReminderStatus = Literal["pending", "completed", "canceled"]


class ReminderCreate(BaseModel):
    pet_type: PetType
    title: str = Field(min_length=1, max_length=200)
    source_text: Optional[str] = Field(default=None, max_length=1000)
    remind_at: datetime


class ReminderUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    remind_at: Optional[datetime] = None
    status: Optional[ReminderStatus] = None


class ReminderResponse(BaseModel):
    id: int
    user_id: int
    pet_type: PetType
    title: str
    source_text: Optional[str] = None
    remind_at: datetime
    status: ReminderStatus
    triggered_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PendingReminderSummary(BaseModel):
    pet_type: PetType
    pending_count: int
```

- [ ] **Step 5: Add Alembic migration**

Create `backend/alembic/versions/003_pet_reminders.py`.

```python
"""add pet reminders

Revision ID: 003_pet_reminders
Revises: 002_platform_upgrade
Create Date: 2026-07-06
"""

from alembic import op
import sqlalchemy as sa

revision = "003_pet_reminders"
down_revision = "002_platform_upgrade"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=True),
        sa.Column("remind_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("triggered_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_reminders_user_id", "reminders", ["user_id"])
    op.create_index("ix_reminders_pet_type", "reminders", ["pet_type"])
    op.create_index("ix_reminders_remind_at", "reminders", ["remind_at"])
    op.create_index("ix_reminders_status", "reminders", ["status"])


def downgrade() -> None:
    op.drop_index("ix_reminders_status", table_name="reminders")
    op.drop_index("ix_reminders_remind_at", table_name="reminders")
    op.drop_index("ix_reminders_pet_type", table_name="reminders")
    op.drop_index("ix_reminders_user_id", table_name="reminders")
    op.drop_table("reminders")
```

- [ ] **Step 6: Run backend import check**

Run:

```powershell
cd backend
python -m compileall app
```

Expected: compile completes without syntax errors.

---

## Task 2: Backend Reminder API

**Files:**
- Create: `backend/app/api/v1/reminders.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/test_reminders.py`

- [ ] **Step 1: Write reminder API tests**

Create `backend/tests/test_reminders.py` with these cases:

```python
import os
import shutil
from datetime import timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

TEST_ROOT = Path(__file__).resolve().parent / ".runtime-reminders"
if TEST_ROOT.exists():
    shutil.rmtree(TEST_ROOT)
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(TEST_ROOT / 'test.db').as_posix()}"
os.environ["CHROMA_PERSIST_DIR"] = str(TEST_ROOT / "chroma")
os.environ["UPLOAD_DIR"] = str(TEST_ROOT / "uploads")
os.environ["DOWNLOAD_DIR"] = str(TEST_ROOT / "downloads")
os.environ["SMTP_USER"] = ""
os.environ["SMTP_PASSWORD"] = ""

from app.core.time import utc_now  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def register_and_login(client: AsyncClient) -> dict[str, str]:
    response = await client.post("/api/v1/auth/send-verification-code", json={"email": "reminder@example.com"})
    assert response.status_code == 200

    from app.models.database import async_session_maker  # noqa: E402
    from app.models.user import VerificationCode  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async with async_session_maker() as session:
        result = await session.execute(select(VerificationCode).where(VerificationCode.email == "reminder@example.com"))
        code = result.scalar_one().code

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "reminderuser",
            "email": "reminder@example.com",
            "password": "Password123!",
            "verification_code": code,
        },
    )
    assert response.status_code == 200

    response = await client.post(
        "/api/v1/auth/login",
        data={"username": "reminderuser", "password": "Password123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.mark.asyncio
async def test_reminders_are_scoped_by_user_pet_and_status(client: AsyncClient):
    headers = await register_and_login(client)
    remind_at = (utc_now() + timedelta(hours=1)).isoformat()

    created = await client.post(
        "/api/v1/reminders",
        headers=headers,
        json={
            "pet_type": "pig",
            "title": "下午三点开会",
            "source_text": "下午三点有一个会议",
            "remind_at": remind_at,
        },
    )
    assert created.status_code == 200
    reminder_id = created.json()["id"]
    assert created.json()["pet_type"] == "pig"
    assert created.json()["status"] == "pending"

    pig_list = await client.get("/api/v1/reminders?pet_type=pig&status=pending", headers=headers)
    assert pig_list.status_code == 200
    assert [item["id"] for item in pig_list.json()] == [reminder_id]

    cat_list = await client.get("/api/v1/reminders?pet_type=cat&status=pending", headers=headers)
    assert cat_list.status_code == 200
    assert cat_list.json() == []

    summary = await client.get("/api/v1/reminders/pending-summary?pet_type=pig", headers=headers)
    assert summary.status_code == 200
    assert summary.json() == {"pet_type": "pig", "pending_count": 1}

    completed = await client.post(f"/api/v1/reminders/{reminder_id}/complete", headers=headers)
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["triggered_at"] is not None

    empty = await client.get("/api/v1/reminders?pet_type=pig&status=pending", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd backend
pytest tests/test_reminders.py -q -p no:cacheprovider
```

Expected: FAIL because `/api/v1/reminders` does not exist.

- [ ] **Step 3: Implement reminder router**

Create `backend/app/api/v1/reminders.py`.

```python
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.time import utc_now
from app.models.database import Reminder, get_db
from app.models.user import User
from app.schemas.reminder import (
    PendingReminderSummary,
    ReminderCreate,
    ReminderResponse,
    ReminderUpdate,
)

router = APIRouter(prefix="/reminders", tags=["reminders"])


async def get_owned_reminder(reminder_id: int, current_user: User, db: AsyncSession) -> Reminder:
    result = await db.execute(
        select(Reminder).where(Reminder.id == reminder_id, Reminder.user_id == current_user.id)
    )
    reminder = result.scalar_one_or_none()
    if not reminder:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return reminder


@router.post("", response_model=ReminderResponse)
async def create_reminder(
    payload: ReminderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = Reminder(
        user_id=current_user.id,
        pet_type=payload.pet_type,
        title=payload.title,
        source_text=payload.source_text,
        remind_at=payload.remind_at,
        status="pending",
    )
    db.add(reminder)
    await db.commit()
    await db.refresh(reminder)
    return reminder


@router.get("", response_model=List[ReminderResponse])
async def list_reminders(
    pet_type: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    due_before: Optional[datetime] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Reminder).where(Reminder.user_id == current_user.id)
    if pet_type:
        query = query.where(Reminder.pet_type == pet_type)
    if status:
        query = query.where(Reminder.status == status)
    if due_before:
        query = query.where(Reminder.remind_at <= due_before)
    query = query.order_by(Reminder.remind_at.asc(), Reminder.id.asc())
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/pending-summary", response_model=PendingReminderSummary)
async def pending_summary(
    pet_type: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Reminder).where(
            Reminder.user_id == current_user.id,
            Reminder.pet_type == pet_type,
            Reminder.status == "pending",
        )
    )
    return PendingReminderSummary(pet_type=pet_type, pending_count=len(result.scalars().all()))


@router.patch("/{reminder_id}", response_model=ReminderResponse)
async def update_reminder(
    reminder_id: int,
    payload: ReminderUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = await get_owned_reminder(reminder_id, current_user, db)
    if payload.title is not None:
        reminder.title = payload.title
    if payload.remind_at is not None:
        reminder.remind_at = payload.remind_at
    if payload.status is not None:
        reminder.status = payload.status
        if payload.status in {"completed", "canceled"}:
            reminder.completed_at = utc_now()
    await db.commit()
    await db.refresh(reminder)
    return reminder


@router.post("/{reminder_id}/complete", response_model=ReminderResponse)
async def complete_reminder(
    reminder_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    reminder = await get_owned_reminder(reminder_id, current_user, db)
    now = utc_now()
    reminder.status = "completed"
    reminder.triggered_at = now
    reminder.completed_at = now
    await db.commit()
    await db.refresh(reminder)
    return reminder
```

- [ ] **Step 4: Mount router**

Modify `backend/app/api/router.py`.

```python
from app.api.v1 import admin, auth, chat, public, rag, reminders, rtc, tools, users

api_router.include_router(reminders.router)
```

- [ ] **Step 5: Run backend reminder tests**

Run:

```powershell
cd backend
pytest tests/test_reminders.py -q -p no:cacheprovider
```

Expected: PASS.

- [ ] **Step 6: Run nearest existing backend tests**

Run:

```powershell
cd backend
pytest tests/test_main.py -q -p no:cacheprovider
```

Expected: PASS.

---

## Task 3: Pig Animation Assets

**Files:**
- Create PNGs under `frontend/src/assets/pets/pig/animations/*/`
- Modify later in: `desktop/src/shared/pet-animation-config.js`

- [ ] **Step 1: Establish asset canvas**

Use the current `frontend/src/assets/pets/pig/idle.png` as the style and size reference. Export all animation frames as transparent PNGs with one consistent canvas size. Use the same visual scale and baseline across all frames so the pet does not jitter.

- [ ] **Step 2: Create action directories**

Create these directories:

```text
frontend/src/assets/pets/pig/animations/idle/
frontend/src/assets/pets/pig/animations/walk/
frontend/src/assets/pets/pig/animations/jump/
frontend/src/assets/pets/pig/animations/happy/
frontend/src/assets/pets/pig/animations/confused/
frontend/src/assets/pets/pig/animations/reminding/
frontend/src/assets/pets/pig/animations/sleeping/
```

- [ ] **Step 3: Add frame files**

Add these files for each action:

```text
frame-01.png
frame-02.png
frame-03.png
frame-04.png
frame-05.png
frame-06.png
```

For `walk`, `jump`, `happy`, and `reminding`, add `frame-07.png` and `frame-08.png` when the motion reads better with eight frames.

- [ ] **Step 4: Check visual consistency**

Open each sequence as a flipbook or preview. Acceptance:

- No opaque background.
- No sudden scale change between frames.
- Feet/body baseline is stable for `idle`, `happy`, `confused`, `reminding`, `sleeping`.
- `walk` moves in-place inside the same canvas; the renderer controls window movement separately.
- `jump` returns to the same baseline on the final frame.

---

## Task 4: Desktop Animation Registry And State Machine

**Files:**
- Create: `desktop/src/shared/pet-animation-config.js`
- Create: `desktop/src/shared/pet-animation-state.js`
- Create: `desktop/src/components/PetAnimator.jsx`
- Modify: `desktop/scripts/test.mjs`

- [ ] **Step 1: Write pure state tests**

Append to `desktop/scripts/test.mjs` after existing imports and assertions:

```javascript
import {
  ANIMATION_ACTIONS,
  createInitialPetAnimationState,
  petAnimationReducer,
} from '../src/shared/pet-animation-state.js'

const initialPetAnimation = createInitialPetAnimationState()
assert.equal(initialPetAnimation.action, ANIMATION_ACTIONS.IDLE)

const remindingPetAnimation = petAnimationReducer(initialPetAnimation, {
  type: 'REMINDER_DUE',
  message: '15:00 开会',
})
assert.equal(remindingPetAnimation.action, ANIMATION_ACTIONS.REMINDING)
assert.equal(remindingPetAnimation.locked, true)

const ignoredIdle = petAnimationReducer(remindingPetAnimation, { type: 'IDLE_TICK' })
assert.equal(ignoredIdle.action, ANIMATION_ACTIONS.REMINDING)

const released = petAnimationReducer(remindingPetAnimation, { type: 'ANIMATION_DONE' })
assert.equal(released.action, ANIMATION_ACTIONS.IDLE)
assert.equal(released.locked, false)

const confused = petAnimationReducer(initialPetAnimation, { type: 'REMINDER_PARSE_FAILED' })
assert.equal(confused.action, ANIMATION_ACTIONS.CONFUSED)
```

- [ ] **Step 2: Run desktop tests and verify failure**

Run:

```powershell
cd desktop
npm.cmd run test
```

Expected: FAIL because `pet-animation-state.js` does not exist.

- [ ] **Step 3: Implement animation state reducer**

Create `desktop/src/shared/pet-animation-state.js`.

```javascript
export const ANIMATION_ACTIONS = {
  IDLE: 'idle',
  WALK: 'walk',
  JUMP: 'jump',
  HAPPY: 'happy',
  CONFUSED: 'confused',
  REMINDING: 'reminding',
  SLEEPING: 'sleeping',
}

const LOCKED_ACTIONS = new Set([ANIMATION_ACTIONS.REMINDING])

export function createInitialPetAnimationState() {
  return {
    action: ANIMATION_ACTIONS.IDLE,
    locked: false,
    message: '',
    lastInteractionAt: Date.now(),
  }
}

function transition(action, patch = {}) {
  return {
    action,
    locked: LOCKED_ACTIONS.has(action),
    message: patch.message || '',
    lastInteractionAt: patch.lastInteractionAt || Date.now(),
  }
}

export function petAnimationReducer(state, event) {
  if (state.locked && event.type !== 'ANIMATION_DONE' && event.type !== 'WAKE') {
    return state
  }

  switch (event.type) {
    case 'REMINDER_DUE':
      return transition(ANIMATION_ACTIONS.REMINDING, { message: event.message })
    case 'REMINDER_CREATED':
    case 'CHAT_SUCCESS':
      return transition(ANIMATION_ACTIONS.HAPPY, { message: event.message })
    case 'REMINDER_PARSE_FAILED':
    case 'CHAT_ERROR':
      return transition(ANIMATION_ACTIONS.CONFUSED, { message: event.message })
    case 'PET_CLICK':
      return transition(ANIMATION_ACTIONS.JUMP)
    case 'IDLE_TICK':
      return transition(Math.random() > 0.55 ? ANIMATION_ACTIONS.WALK : ANIMATION_ACTIONS.JUMP)
    case 'SLEEP':
      return transition(ANIMATION_ACTIONS.SLEEPING)
    case 'WAKE':
    case 'ANIMATION_DONE':
      return transition(ANIMATION_ACTIONS.IDLE)
    default:
      return state
  }
}
```

- [ ] **Step 4: Implement animation config**

Create `desktop/src/shared/pet-animation-config.js`.

```javascript
import pigIdle01 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-01.png'
import pigIdle02 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-02.png'
import pigIdle03 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-03.png'
import pigIdle04 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-04.png'
import pigIdle05 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-05.png'
import pigIdle06 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-06.png'
import pigWalk01 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-01.png'
import pigWalk02 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-02.png'
import pigWalk03 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-03.png'
import pigWalk04 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-04.png'
import pigWalk05 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-05.png'
import pigWalk06 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-06.png'
import pigJump01 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-01.png'
import pigJump02 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-02.png'
import pigJump03 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-03.png'
import pigJump04 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-04.png'
import pigJump05 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-05.png'
import pigJump06 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-06.png'
import pigHappy01 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-01.png'
import pigHappy02 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-02.png'
import pigHappy03 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-03.png'
import pigHappy04 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-04.png'
import pigHappy05 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-05.png'
import pigHappy06 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-06.png'
import pigConfused01 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-01.png'
import pigConfused02 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-02.png'
import pigConfused03 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-03.png'
import pigConfused04 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-04.png'
import pigConfused05 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-05.png'
import pigConfused06 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-06.png'
import pigReminding01 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-01.png'
import pigReminding02 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-02.png'
import pigReminding03 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-03.png'
import pigReminding04 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-04.png'
import pigReminding05 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-05.png'
import pigReminding06 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-06.png'
import pigSleeping01 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-01.png'
import pigSleeping02 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-02.png'
import pigSleeping03 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-03.png'
import pigSleeping04 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-04.png'

import { getPetVisual } from './pets'

const pigAnimations = {
  idle: [pigIdle01, pigIdle02, pigIdle03, pigIdle04, pigIdle05, pigIdle06],
  walk: [pigWalk01, pigWalk02, pigWalk03, pigWalk04, pigWalk05, pigWalk06],
  jump: [pigJump01, pigJump02, pigJump03, pigJump04, pigJump05, pigJump06],
  happy: [pigHappy01, pigHappy02, pigHappy03, pigHappy04, pigHappy05, pigHappy06],
  confused: [pigConfused01, pigConfused02, pigConfused03, pigConfused04, pigConfused05, pigConfused06],
  reminding: [pigReminding01, pigReminding02, pigReminding03, pigReminding04, pigReminding05, pigReminding06],
  sleeping: [pigSleeping01, pigSleeping02, pigSleeping03, pigSleeping04],
}

export function getPetAnimationFrames(petType, action) {
  if (petType === 'pig' && pigAnimations[action]?.length) {
    return pigAnimations[action]
  }

  const fallbackMood = action === 'happy' || action === 'jump' ? 'happy' : action === 'confused' ? 'sad' : 'idle'
  return [getPetVisual(petType, fallbackMood).image]
}
```

If eight-frame actions are exported, extend the relevant imports and arrays in the same file.

- [ ] **Step 5: Implement PetAnimator**

Create `desktop/src/components/PetAnimator.jsx`.

```javascript
import { useEffect, useMemo, useState } from 'react'

import { getPetAnimationFrames } from '../shared/pet-animation-config'

export function PetAnimator({ petType, action, alt, onCycleComplete }) {
  const frames = useMemo(() => getPetAnimationFrames(petType, action), [petType, action])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [action, petType])

  useEffect(() => {
    if (frames.length <= 1) {
      return undefined
    }

    const timer = window.setInterval(() => {
      setIndex((current) => {
        const next = (current + 1) % frames.length
        if (next === 0) {
          onCycleComplete?.(action)
        }
        return next
      })
    }, 110)

    return () => window.clearInterval(timer)
  }, [action, frames.length, onCycleComplete])

  return <img className="pet-image" src={frames[index] || frames[0]} alt={alt} draggable="false" />
}
```

- [ ] **Step 6: Run desktop tests**

Run:

```powershell
cd desktop
npm.cmd run test
```

Expected: PASS.

---

## Task 5: Reminder Parser And API Wrapper

**Files:**
- Create: `desktop/src/shared/reminder-parser.js`
- Create: `desktop/src/shared/reminders-api.js`
- Create: `desktop/src/shared/pet-personality.js`
- Modify: `desktop/scripts/test.mjs`

- [ ] **Step 1: Add parser tests**

Append to `desktop/scripts/test.mjs`:

```javascript
import { parseOneTimeReminder } from '../src/shared/reminder-parser.js'

const fixedNow = new Date('2026-07-06T10:00:00+08:00')

const todayMeeting = parseOneTimeReminder('下午三点有一个会议', fixedNow)
assert.equal(todayMeeting.ok, true)
assert.equal(todayMeeting.title, '开会')
assert.equal(todayMeeting.remindAt.getHours(), 15)

const tomorrowTask = parseOneTimeReminder('明早九点交材料', fixedNow)
assert.equal(tomorrowTask.ok, true)
assert.equal(tomorrowTask.title, '交材料')
assert.equal(tomorrowTask.remindAt.getDate(), 7)
assert.equal(tomorrowTask.remindAt.getHours(), 9)

const unclear = parseOneTimeReminder('提醒我一下', fixedNow)
assert.equal(unclear.ok, false)
assert.equal(unclear.reason, 'missing_time')
```

- [ ] **Step 2: Implement parser**

Create `desktop/src/shared/reminder-parser.js`.

```javascript
const CHINESE_HOURS = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function parseHour(rawHour) {
  if (/^\d+$/.test(rawHour)) {
    return Number(rawHour)
  }
  if (rawHour === '十一') return 11
  if (rawHour === '十二') return 12
  return CHINESE_HOURS[rawHour] || null
}

function stripReminderWords(text) {
  return text
    .replace(/提醒我|帮我|记得|到时候|有一个|有个/g, '')
    .replace(/今天|明天|明早|明晚|后天|上午|下午|晚上|早上|中午/g, '')
    .replace(/\d{1,2}[:：]\d{2}/g, '')
    .replace(/[一二两三四五六七八九十]{1,2}点半?/g, '')
    .replace(/\d{1,2}点半?/g, '')
    .replace(/[，。,.]/g, '')
    .trim()
}

function normalizeTitle(text) {
  const stripped = stripReminderWords(text)
  if (!stripped || stripped === '会议') {
    return '开会'
  }
  return stripped.slice(0, 80)
}

export function parseOneTimeReminder(input, now = new Date()) {
  const text = String(input || '').trim()
  if (!text) {
    return { ok: false, reason: 'empty' }
  }

  const hasReminderIntent = /提醒|会议|开会|交|提交|下午|明天|明早|后天/.test(text)
  if (!hasReminderIntent) {
    return { ok: false, reason: 'not_reminder' }
  }

  const date = new Date(now)
  if (/后天/.test(text)) {
    date.setDate(date.getDate() + 2)
  } else if (/明天|明早|明晚/.test(text)) {
    date.setDate(date.getDate() + 1)
  }

  let hour = null
  let minute = 0

  const clockMatch = text.match(/(\d{1,2})[:：](\d{2})/)
  if (clockMatch) {
    hour = Number(clockMatch[1])
    minute = Number(clockMatch[2])
  } else {
    const hourMatch = text.match(/(\d{1,2}|十一|十二|[一二两三四五六七八九十])点(半)?/)
    if (hourMatch) {
      hour = parseHour(hourMatch[1])
      minute = hourMatch[2] ? 30 : 0
    }
  }

  if (hour === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, reason: 'missing_time' }
  }

  if (/下午|晚上|明晚/.test(text) && hour < 12) {
    hour += 12
  }
  if (/中午/.test(text) && hour < 11) {
    hour += 12
  }

  date.setHours(hour, minute, 0, 0)
  if (!/明天|明早|明晚|后天|今天/.test(text) && date.getTime() <= now.getTime()) {
    date.setDate(date.getDate() + 1)
  }

  return {
    ok: true,
    title: normalizeTitle(text),
    sourceText: text,
    remindAt: date,
  }
}
```

- [ ] **Step 3: Implement reminder API wrapper**

Create `desktop/src/shared/reminders-api.js`.

```javascript
import { desktopApiRequest } from './raw-api-request'
```

Before adding this wrapper, expose the existing private `request` helper from `desktop/src/shared/api.js`:

```javascript
export const desktopApiRequest = request
```

Then replace `desktop/src/shared/reminders-api.js` with:

```javascript
import { desktopApiRequest } from './api'

export function createReminder(payload) {
  return desktopApiRequest('/reminders', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getPendingReminders(petType, dueBefore = null) {
  const params = new URLSearchParams({ pet_type: petType, status: 'pending' })
  if (dueBefore) {
    params.set('due_before', dueBefore.toISOString())
  }
  return desktopApiRequest(`/reminders?${params.toString()}`)
}

export function getPendingReminderSummary(petType) {
  const params = new URLSearchParams({ pet_type: petType })
  return desktopApiRequest(`/reminders/pending-summary?${params.toString()}`)
}

export function completeReminder(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}/complete`, {
    method: 'POST',
  })
}
```

- [ ] **Step 4: Implement pet personality copy**

Create `desktop/src/shared/pet-personality.js`.

```javascript
const personality = {
  cat: {
    createdReminder: (title, time) => `行吧，${time} 我会提醒你：${title}。`,
    reminderDue: (title) => `别装没看见，该做「${title}」了。`,
    parseFailed: '这句话我没听懂时间。说清楚几点，我再记。',
  },
  dog: {
    createdReminder: (title, time) => `收到！${time} 我一定提醒你：${title}！`,
    reminderDue: (title) => `到点啦！我们该处理「${title}」了！`,
    parseFailed: '我想帮你记下来，但还差具体时间。',
  },
  pig: {
    createdReminder: (title, time) => `好哦，${time} 我会慢慢提醒你：${title}。`,
    reminderDue: (title) => `时间到啦，记得「${title}」。`,
    parseFailed: '我还没抓到具体时间，再说一遍几点吧。',
  },
}

export function getPetReminderCopy(petType) {
  return personality[petType] || personality.cat
}
```

- [ ] **Step 5: Run desktop tests**

Run:

```powershell
cd desktop
npm.cmd run test
```

Expected: PASS.

---

## Task 6: Desktop Reminder Creation From Text Chat

**Files:**
- Modify: `desktop/src/main-panel.jsx`
- Modify: `desktop/src/quick-chat.jsx`
- Modify: `desktop/electron/main.cjs`
- Modify: `desktop/electron/preload.cjs`
- Use: `desktop/src/shared/reminder-parser.js`
- Use: `desktop/src/shared/reminders-api.js`
- Use: `desktop/src/shared/pet-personality.js`

- [ ] **Step 1: Add Electron reminder event relay**

In `desktop/electron/main.cjs`, add:

```javascript
function sendReminderEventToPet(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return false
  }
  petWindow.webContents.send('desktop:pet-reminder-event', payload)
  return true
}
```

In `registerIpc()` add:

```javascript
ipcMain.handle('desktop:notify-pet-reminder-event', async (_event, payload) => sendReminderEventToPet(payload))
```

In `desktop/electron/preload.cjs`, expose:

```javascript
notifyPetReminderEvent: (payload) => ipcRenderer.invoke('desktop:notify-pet-reminder-event', payload),
onPetReminderEvent: (callback) => {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on('desktop:pet-reminder-event', listener)
  return () => ipcRenderer.removeListener('desktop:pet-reminder-event', listener)
},
```

- [ ] **Step 2: Intercept reminder intent in main panel**

In `desktop/src/main-panel.jsx`, import:

```javascript
import { parseOneTimeReminder } from './shared/reminder-parser'
import { createReminder } from './shared/reminders-api'
import { getPetReminderCopy } from './shared/pet-personality'
```

At the start of `handleSend`, after `const outgoingMessage = prompt.trim()`:

```javascript
const parsedReminder = parseOneTimeReminder(outgoingMessage)
if (parsedReminder.ok) {
  const reminder = await createReminder({
    pet_type: currentPetType,
    title: parsedReminder.title,
    source_text: parsedReminder.sourceText,
    remind_at: parsedReminder.remindAt.toISOString(),
  })
  const timeText = parsedReminder.remindAt.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const copy = getPetReminderCopy(currentPetType).createdReminder(reminder.title, timeText)
  setPrompt('')
  setMessages((current) => [
    ...current,
    { role: 'user', content: outgoingMessage },
    { role: 'assistant', content: copy },
  ])
  setStatusText(copy)
  await window.desktopBridge?.notifyPetReminderEvent?.({
    type: 'created',
    petType: currentPetType,
    title: reminder.title,
    message: copy,
  })
  return
}
if (parsedReminder.reason === 'missing_time') {
  const copy = getPetReminderCopy(currentPetType).parseFailed
  setPrompt('')
  setMessages((current) => [
    ...current,
    { role: 'user', content: outgoingMessage },
    { role: 'assistant', content: copy },
  ])
  await window.desktopBridge?.notifyPetReminderEvent?.({
    type: 'parse_failed',
    petType: currentPetType,
    message: copy,
  })
  return
}
```

- [ ] **Step 3: Intercept reminder intent in quick chat**

In `desktop/src/quick-chat.jsx`, import the same helpers and add equivalent logic at the start of `sendMessage`, using `petType` instead of `currentPetType`.

The assistant message should be appended to `messages`, and `notifyPetReminderEvent` should be called with `type: 'created'` or `type: 'parse_failed'`.

- [ ] **Step 4: Manual check**

Run:

```powershell
cd desktop
npm.cmd run dev
```

Manual acceptance:

- Log in.
- Open quick chat.
- Type `下午三点有一个会议`.
- The message is not sent to normal chat.
- Assistant reply confirms the reminder.
- Pet bubble receives a created reminder event.

---

## Task 7: Desktop Reminder Polling And Pet Animation Integration

**Files:**
- Modify: `desktop/src/pet.jsx`
- Modify: `desktop/src/desktop.css`
- Use: `desktop/src/components/PetAnimator.jsx`
- Use: `desktop/src/shared/pet-animation-state.js`
- Use: `desktop/src/shared/reminders-api.js`
- Use: `desktop/src/shared/pet-personality.js`

- [ ] **Step 1: Replace image rendering with PetAnimator**

In `desktop/src/pet.jsx`, import:

```javascript
import { PetAnimator } from './components/PetAnimator'
import {
  createInitialPetAnimationState,
  petAnimationReducer,
} from './shared/pet-animation-state'
import { completeReminder, getPendingReminders } from './shared/reminders-api'
import { getPetReminderCopy } from './shared/pet-personality'
```

Add reducer:

```javascript
const [petAnimationState, dispatchPetAnimation] = useReducer(
  petAnimationReducer,
  undefined,
  createInitialPetAnimationState,
)
```

Replace:

```jsx
<img className="pet-image" src={petVisual.image} alt={t(language, 'desktopPetAlt', { pet: petLabel })} draggable="false" />
```

with:

```jsx
<PetAnimator
  petType={petType}
  action={petAnimationState.action}
  alt={t(language, 'desktopPetAlt', { pet: petLabel })}
  onCycleComplete={() => dispatchPetAnimation({ type: 'ANIMATION_DONE' })}
/>
```

- [ ] **Step 2: Drive animation from user interaction**

In `handleClick`, before voice behavior:

```javascript
dispatchPetAnimation({ type: 'PET_CLICK' })
```

When a reminder create event is received, dispatch `REMINDER_CREATED`. When parse fails, dispatch `REMINDER_PARSE_FAILED`.

- [ ] **Step 3: Add reminder event listener**

In `desktop/src/pet.jsx`:

```javascript
useEffect(() => {
  const unsubscribe = window.desktopBridge?.onPetReminderEvent?.((payload) => {
    if (!payload || payload.petType !== petTypeRef.current) {
      return
    }
    if (payload.type === 'created') {
      setTransientBubbleForDuration(payload.message, 3200)
      dispatchPetAnimation({ type: 'REMINDER_CREATED', message: payload.message })
    }
    if (payload.type === 'parse_failed') {
      setTransientBubbleForDuration(payload.message, 3200)
      dispatchPetAnimation({ type: 'REMINDER_PARSE_FAILED', message: payload.message })
    }
  })
  return () => unsubscribe?.()
}, [setTransientBubbleForDuration])
```

- [ ] **Step 4: Poll current pet reminders**

In `desktop/src/pet.jsx`, add a polling effect:

```javascript
useEffect(() => {
  let mounted = true
  let inFlight = false

  const poll = async () => {
    if (!hasSessionRef.current || inFlight) {
      return
    }
    inFlight = true
    try {
      const due = await getPendingReminders(petTypeRef.current, new Date())
      if (!mounted || !due.length) {
        return
      }
      const reminder = due[0]
      const copy = getPetReminderCopy(petTypeRef.current).reminderDue(reminder.title)
      setTransientBubbleForDuration(copy, 8000)
      dispatchPetAnimation({ type: 'REMINDER_DUE', message: copy })
      await window.desktopBridge?.showNotification?.({
        title: 'Detachym',
        body: copy,
      })
      await completeReminder(reminder.id)
    } catch (error) {
      loggerRef.current.error('reminder:poll-failed', error)
    } finally {
      inFlight = false
    }
  }

  void poll()
  const timer = window.setInterval(poll, 30000)
  return () => {
    mounted = false
    window.clearInterval(timer)
  }
}, [setTransientBubbleForDuration])
```

- [ ] **Step 5: Add idle and sleep transitions**

Add an interval that dispatches `IDLE_TICK` only when:

- voice phase is idle,
- not dragging,
- no transient bubble is active.

Add a separate timeout that dispatches `SLEEP` after 10 minutes without click, drag, reminder, or chat feedback.

- [ ] **Step 6: Adjust CSS**

In `desktop/src/desktop.css`, keep `.pet-image` stable and remove visual transforms that fight frame animation. Preserve drop shadow.

```css
.pet-image {
  width: 126px;
  height: 126px;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 16px 24px rgba(15, 23, 42, 0.2));
}
```

Do not keep `mood-happy`, `mood-excited`, or `mood-sad` transforms for the animated pig path; frame animation owns motion.

- [ ] **Step 7: Run desktop verification**

Run:

```powershell
cd desktop
npm.cmd run test
npm.cmd run build:renderer
```

Expected: both commands pass.

---

## Task 8: Pet Switch Pending Reminder Warning

**Files:**
- Modify: `desktop/src/main-panel.jsx`
- Use: `desktop/src/shared/reminders-api.js`

- [ ] **Step 1: Import summary API**

In `desktop/src/main-panel.jsx`:

```javascript
import { getPendingReminderSummary } from './shared/reminders-api'
```

- [ ] **Step 2: Warn before switching pet**

At the start of `handlePetSelect`, before `setSavingPet(true)`:

```javascript
const summary = await getPendingReminderSummary(currentPetType)
if (summary.pending_count > 0) {
  const confirmed = window.confirm(
    language === 'zh-CN'
      ? `${currentPetLabel} 还有 ${summary.pending_count} 个待提醒事项，切换后不会提醒。确定切换吗？`
      : `${currentPetLabel} has ${summary.pending_count} pending reminders. They will not trigger after switching. Continue?`,
  )
  if (!confirmed) {
    return
  }
}
```

- [ ] **Step 3: Manual check**

Run:

```powershell
cd desktop
npm.cmd run dev
```

Manual acceptance:

- Current pet is pig.
- Create a future pig reminder.
- Switch to cat.
- Confirmation appears once before switching.
- After confirming, pig reminder does not trigger while cat is active.
- Switch back to pig before due time; reminder triggers at due time.

---

## Task 9: End-To-End Validation

**Files:**
- No new files.

- [ ] **Step 1: Backend validation**

Run:

```powershell
cd backend
pytest tests/test_reminders.py -q -p no:cacheprovider
pytest tests/test_main.py -q -p no:cacheprovider
```

Expected: both pass.

- [ ] **Step 2: Desktop validation**

Run:

```powershell
cd desktop
npm.cmd run test
npm.cmd run build:renderer
```

Expected: both pass.

- [ ] **Step 3: Manual slice validation**

Run backend:

```powershell
cd backend
python -m uvicorn app.main:app --reload --port 5000
```

Run desktop:

```powershell
cd desktop
npm.cmd run dev
```

Manual acceptance:

- Pig renders as frame animation, not only static image switching.
- Pig plays `idle` by default.
- Clicking pig triggers `jump`.
- `下午三点有一个会议` creates a synced pig reminder when pig is active.
- Successful creation triggers pig `happy`.
- Missing-time input triggers pig `confused`.
- Due reminder triggers pig `reminding`, desktop notification, and backend completion.
- Switching away from pig with pending pig reminders shows a warning.
- Pig reminders do not trigger while cat or dog is active.
- RTC paths still exist but are not tested as part of this slice.

---

## Self-Review

### Spec Coverage

- Desktop-only direction is covered by Tasks 3-8.
- Pig vertical slice is covered by Tasks 3, 4, 7, and 9.
- Backend synced one-time reminders are covered by Tasks 1 and 2.
- Current-pet-only reminder triggering is covered by Tasks 7 and 8.
- Animal identity isolation is represented by `pet_type` on reminders and switch warning behavior.
- RTC exclusion is stated in scope and validation.

### Placeholder Scan

This document does not rely on unfinished placeholder markers, open-ended placeholder sections, or unnamed files. The only variable execution choice is whether specific high-motion actions use 6 or 8 frames; both accepted filenames are listed explicitly.

### Type Consistency

- Backend uses `pet_type`, `remind_at`, `source_text`, and `status`.
- Desktop sends `pet_type`, `title`, `source_text`, and `remind_at`.
- Desktop uses API functions `createReminder`, `getPendingReminders`, `getPendingReminderSummary`, and `completeReminder`.
- Animation actions are `idle`, `walk`, `jump`, `happy`, `confused`, `reminding`, and `sleeping`.

## Execution Choice

Plan is saved for execution from `docs/ExcutionDocs/2026-07-06-desktop-pet-interaction-reminders-execution.md`.

Recommended execution mode:

1. Subagent-driven execution for backend reminders, desktop state machine, and desktop UI integration as separate checkpoints.
2. Inline execution only if one engineer will keep the whole state in one working session and review after every task.
