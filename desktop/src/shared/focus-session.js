const PET_TYPES = ['cat', 'dog', 'pig']

export function isFocusSnapshotCurrent(snapshot, context) {
  return Boolean(
    context?.hasSession && PET_TYPES.includes(context.petType)
    && typeof context.server === 'string' && Boolean(context.server)
    && snapshot?.server === context.server.replace(/\/+$/, '')
    && snapshot?.userId === context.userId && snapshot?.petType === context.petType
    && snapshot?.generation === context.session?.generation,
  )
}

export function getFocusRemainingMs(state, now = Date.now()) {
  if (!state || state.status === 'idle' || state.status === 'completed') return 0
  const remaining = state.status === 'running' ? state.endsAt - now : state.remainingMs
  return Number.isFinite(remaining) ? Math.max(0, Math.min(state.durationMs, remaining)) : 0
}

export function getFocusSnapshotRemainingMs(snapshot, now = performance.now()) {
  const state = snapshot?.state
  if (!state || state.status === 'idle' || state.status === 'completed') return 0
  const elapsed = state.status === 'running' ? Math.max(0, now - snapshot.receivedAtElapsedMs) : 0
  const remaining = state.remainingMs - elapsed
  return Number.isFinite(remaining) ? Math.max(0, Math.min(state.durationMs, remaining)) : 0
}

export function captureFocusSnapshot(snapshot, previous = null, now = performance.now()) {
  if (!snapshot?.state) return snapshot
  const sameAccount = previous?.server === snapshot.server && previous?.userId === snapshot.userId
    && previous?.petType === snapshot.petType && previous?.generation === snapshot.generation
  if (sameAccount && previous.state?.revision > snapshot.state.revision) return previous
  let state = snapshot.state
  if (sameAccount && state.status === 'running' && previous.state?.status === 'running'
    && state.id === previous.state.id && state.revision === previous.state.revision) {
    // A delayed read of the same revision must not rewind the countdown.
    state = { ...state, remainingMs: Math.min(state.remainingMs, getFocusSnapshotRemainingMs(previous, now)) }
  }
  return { ...snapshot, state, receivedAtElapsedMs: now }
}

export function formatFocusTime(remainingMs) {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000)
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
}
