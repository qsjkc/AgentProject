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

const PET_FOCUS_RETRY_DELAYS_MS = [250, 1000, 3000]

export function createPetFocusRecovery({
  getContext,
  getServer,
  read,
  onReadError,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const { userId, petType, session } = getContext()
  const generation = session?.generation
  let server = null
  let serverNeedsVerification = true
  let snapshot = null
  let pending = null
  let timer = null
  let retries = 0
  let disposed = false

  function getCurrentContext() {
    const current = getContext()
    return !disposed && current.hasSession && current.userId === userId
      && current.petType === petType && current.session?.generation === generation
      ? current : null
  }

  function hasCurrentSnapshot() {
    return !serverNeedsVerification && isFocusSnapshotCurrent(snapshot, { ...getCurrentContext(), server })
  }

  function clearRetry() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function accept(value) {
    if (!value?.state || !isFocusSnapshotCurrent(value, { ...getCurrentContext(), server })) return
    snapshot = captureFocusSnapshot(value, snapshot)
    retries = 0
    clearRetry()
  }

  async function refreshServer() {
    const url = await getServer()
    if (!getCurrentContext()) return false
    const nextServer = typeof url === 'string' ? url.replace(/\/+$/, '') : null
    if (nextServer !== server) snapshot = null
    server = nextServer
    serverNeedsVerification = false
    return Boolean(server)
  }

  async function readSnapshot() {
    if (!getCurrentContext() || !await refreshServer() || hasCurrentSnapshot()) return
    const value = await read({ ...getCurrentContext(), server })
    if (value?.ok && getCurrentContext() && await refreshServer()) accept(value)
  }

  function request() {
    if (pending || timer !== null || !getCurrentContext() || hasCurrentSnapshot()) return pending
    pending = Promise.resolve().then(readSnapshot).catch((error) => {
      if (getCurrentContext()) onReadError?.(error)
    }).finally(() => {
      pending = null
      if (!getCurrentContext() || hasCurrentSnapshot() || retries >= PET_FOCUS_RETRY_DELAYS_MS.length) return
      timer = setTimer(() => {
        timer = null
        void request()
      }, PET_FOCUS_RETRY_DELAYS_MS[retries++])
    })
    return pending
  }

  function receive(value) {
    if (!value?.state || !isFocusSnapshotCurrent(value, { ...getCurrentContext(), server: value.server })) return
    if (value.server !== server) {
      // Only the native server lookup can establish a new server scope.
      serverNeedsVerification = true
      void request()
      return
    }
    accept(value)
  }

  return {
    request,
    receive,
    shouldHoldProactive: () => !hasCurrentSnapshot()
      || (snapshot.state.status === 'running' && getFocusSnapshotRemainingMs(snapshot) > 0),
    dispose: () => {
      disposed = true
      clearRetry()
    },
  }
}

export function formatFocusTime(remainingMs) {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000)
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
}
