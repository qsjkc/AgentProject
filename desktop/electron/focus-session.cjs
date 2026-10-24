const PET_TYPES = ['cat', 'dog', 'pig']

const DURATIONS = [15, 25, 45]
const MAX_DURATION_MS = 45 * 60 * 1000
const MAX_HISTORY_ENTRIES = 200

function normalizeFocusHistory(value) {
  if (!Array.isArray(value)) return []
  // Bound storage by count, not the wall clock: clock corrections must not
  // permanently erase completed work. The renderer selects its date window.
  const entries = value.filter((entry) => entry
    && typeof entry.id === 'string' && entry.id.trim()
    && typeof entry.intention === 'string'
    && Number.isFinite(entry.durationMs) && DURATIONS.includes(entry.durationMs / 60000)
    && Number.isFinite(entry.completedAt) && Number.isFinite(new Date(entry.completedAt).getTime()))
    .sort((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id))
  const seen = new Set()
  const history = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    history.push({ id: entry.id, intention: entry.intention.slice(0, 80), durationMs: entry.durationMs, completedAt: entry.completedAt })
    if (history.length === MAX_HISTORY_ENTRIES) break
  }
  return history
}

function sameFocusHistory(stored, history) {
  // Older records have no history field. Do not rewrite an empty record just
  // to add one, or persist the same completed history on every read.
  if (!Array.isArray(stored)) return stored === undefined && history.length === 0
  return stored.length === history.length && stored.every((entry, index) => entry
    && entry.id === history[index].id && entry.intention === history[index].intention
    && entry.durationMs === history[index].durationMs && entry.completedAt === history[index].completedAt)
}

function emptyFocusSession(revision = 0) {
  return { status: 'idle', revision, id: null, intention: '', durationMs: 0, remainingMs: 0, endsAt: null, completedAt: null }
}

function normalizeFocusSession(value) {
  const revision = Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0
  if (
    !value || !['running', 'paused', 'completed'].includes(value.status)
    || typeof value.id !== 'string' || !value.id
    || !DURATIONS.includes(value.durationMs / 60000)
    || !Number.isFinite(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > value.durationMs
    || (value.status === 'running' && !Number.isFinite(value.endsAt))
  ) return emptyFocusSession(revision)
  return {
    status: value.status,
    revision,
    id: value.id,
    intention: typeof value.intention === 'string' ? value.intention.slice(0, 80) : '',
    durationMs: value.durationMs,
    remainingMs: value.status === 'completed' ? 0 : value.remainingMs,
    endsAt: value.status === 'running' ? value.endsAt : null,
    completedAt: value.status === 'completed' && Number.isFinite(value.completedAt) ? value.completedAt : null,
  }
}

function settleFocusSession(state, now) {
  if (state.status !== 'running' || state.endsAt > now) return state
  return { ...state, status: 'completed', remainingMs: 0, endsAt: null, completedAt: state.endsAt, revision: state.revision + 1 }
}

function transitionFocusSession(state, command, payload, now, createId) {
  if (payload?.expectedRevision !== state.revision) return { ok: false, reason: 'conflict', state }
  let next
  if (command === 'start' && ['idle', 'completed'].includes(state.status)) {
    if (!DURATIONS.includes(payload.minutes)) return { ok: false, reason: 'invalid-duration', state }
    const durationMs = payload.minutes * 60000
    next = {
      ...emptyFocusSession(),
      status: 'running', id: createId(),
      intention: typeof payload.intention === 'string' ? payload.intention.trim().slice(0, 80) : '',
      durationMs, remainingMs: durationMs, endsAt: now + durationMs,
    }
  } else if (command === 'pause' && state.status === 'running') {
    next = { ...state, status: 'paused', remainingMs: Math.max(0, Math.min(state.durationMs, state.endsAt - now)), endsAt: null }
  } else if (command === 'resume' && state.status === 'paused') {
    next = { ...state, status: 'running', endsAt: now + state.remainingMs }
  } else if (command === 'reset' && state.status !== 'idle') {
    next = emptyFocusSession()
  } else {
    return { ok: false, reason: 'invalid-transition', state }
  }
  return { ok: true, state: { ...next, revision: state.revision + 1 } }
}

function createFocusAccountKey({ server, hasSession, userId, petType } = {}) {
  if (!hasSession || !Number.isInteger(userId) || userId <= 0 || !PET_TYPES.includes(petType) || typeof server !== 'string' || !server) return null
  return JSON.stringify([server.replace(/\/+$/, ''), userId, petType])
}

function createFocusSessionController({ read, write, now, elapsedNow, createId, onChange = () => {}, onComplete = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const wallNow = now ?? Date.now
  // Keep existing single-clock test callers working; production uses libuv's
  // monotonic clock (QPC on Windows), independent of system clock adjustments.
  const monotonicNow = elapsedNow ?? now ?? (() => Number(process.hrtime.bigint() / 1_000_000n))
  const runningClocks = new Map()
  let context = null
  let key = null
  let timer = null

  function stopTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  function snapshot(state, history = []) {
    const server = typeof context?.server === 'string' ? context.server.replace(/\/+$/, '') : null
    return { server: server || null, userId: context?.userId ?? null, petType: context?.petType ?? null, generation: context?.session?.generation ?? null, state, history }
  }
  function runningState(accountKey, state, wall, elapsed) {
    if (state.status !== 'running') {
      runningClocks.delete(accountKey)
      return state
    }
    let clock = runningClocks.get(accountKey)
    if (!clock || clock.id !== state.id || clock.revision !== state.revision) {
      // Only startup/restored sessions consult the persisted wall deadline.
      // A wall-clock rollback while the process was stopped must not restore
      // more time than was left at its last persisted checkpoint.
      const restoredRemaining = Math.min(state.remainingMs, state.endsAt - wall)
      clock = { id: state.id, revision: state.revision, endsAt: elapsed + restoredRemaining }
      runningClocks.set(accountKey, clock)
    }
    const remaining = clock.endsAt - elapsed
    return { ...state, endsAt: wall + remaining, remainingMs: Math.max(0, Math.min(state.durationMs, remaining)) }
  }
  function reconcile(accountKey, persistRemaining = false) {
    const record = read(accountKey)
    const stored = normalizeFocusSession(record)
    const wall = wallNow()
    const state = runningState(accountKey, stored, wall, monotonicNow())
    const settled = settleFocusSession(state, wall)
    const entries = Array.isArray(record?.history) ? record.history : []
    // Reconcile completed states independently of notifications, including
    // legacy records and sessions that expired while their account was hidden.
    const history = normalizeFocusHistory(settled.status === 'completed' ? [...entries, settled] : entries)
    const completed = settled !== state
    // Rebase deadlines after clock changes, without writing on every read or
    // changing the revision used to arbitrate actual user commands.
    const checkpoint = settled.status === 'running' && (Math.abs(settled.endsAt - stored.endsAt) >= 1000
      || (persistRemaining && settled.remainingMs !== stored.remainingMs))
    if (completed || checkpoint || !sameFocusHistory(record?.history, history)) write(accountKey, { ...settled, history })
    if (completed) runningClocks.delete(accountKey)
    return { state: settled, history, completed }
  }
  function current({ notify = true } = {}) {
    if (!key) return snapshot(null)
    const result = reconcile(key)
    const currentSnapshot = snapshot(result.state, result.history)
    if (result.completed) {
      onChange(currentSnapshot)
      if (notify) onComplete(currentSnapshot)
    }
    return currentSnapshot
  }
  function arm({ notify = true } = {}) {
    stopTimer()
    const state = current({ notify }).state
    if (state?.status !== 'running') return
    const scheduledKey = key
    timer = setTimer(() => {
      timer = null
      if (key !== scheduledKey) return
      current({ notify: true })
      arm()
    }, Math.max(1, Math.min(MAX_DURATION_MS, state.remainingMs)))
    timer?.unref?.()
  }
  function setContext(nextContext) {
    const nextKey = createFocusAccountKey(nextContext)
    const changed = nextKey !== key || nextContext?.session?.generation !== context?.session?.generation
    if (changed && key) reconcile(key, true)
    context = nextContext
    key = nextKey
    if (changed) {
      arm({ notify: false })
      onChange(current({ notify: false }))
    }
    return current({ notify: !changed })
  }
  function update(command, payload) {
    if (!key) return { ok: false, reason: 'no-account', ...current() }
    const previous = current()
    const result = transitionFocusSession(previous.state, command, payload, wallNow(), createId)
    if (!result.ok) return { ...result, ...snapshot(result.state, previous.history) }
    write(key, { ...result.state, history: previous.history })
    arm()
    const resultSnapshot = current()
    onChange(resultSnapshot)
    return { ok: true, ...resultSnapshot }
  }
  return {
    current,
    setContext,
    update,
    resume() { current({ notify: true }); arm() },
    dispose() {
      stopTimer()
      // Include inactive accounts: their clocks keep advancing while hidden.
      for (const accountKey of runningClocks.keys()) reconcile(accountKey, true)
      runningClocks.clear()
    },
  }
}

module.exports = { createFocusAccountKey, createFocusSessionController, emptyFocusSession, normalizeFocusSession, settleFocusSession, transitionFocusSession }
