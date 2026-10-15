const REMINDER_RECONCILE_MS = 30_000

// This clock only asks the pet renderer to check the server. It never stores
// reminder content, credentials, or authority to deliver a notification.
function createReminderWakeupController({
  getContextKey,
  isOwnerCurrent,
  onWake,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null
  let owner = null
  let contextKey = null
  let sequence = 0
  let timerGeneration = 0
  let disposed = false

  function clear() {
    timerGeneration += 1
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function cancel() {
    clear()
    owner = null
    contextKey = null
    sequence = 0
  }

  function current() {
    return !disposed && owner !== null && contextKey !== null
      && contextKey === getContextKey() && isOwnerCurrent(owner)
  }

  function arm(at) {
    clear()
    const generation = timerGeneration
    timer = setTimer(() => {
      if (generation !== timerGeneration) return
      timer = null
      wake()
    }, Math.max(1, Math.min(REMINDER_RECONCILE_MS, at - now())))
    timer?.unref?.()
  }

  function wake() {
    if (!current()) {
      cancel()
      return false
    }
    // Keep reconciliation alive if the renderer cannot re-arm after an error.
    arm(now() + REMINDER_RECONCILE_MS)
    onWake(owner)
    return true
  }

  return {
    schedule(nextOwner, at, nextSequence) {
      const nextKey = getContextKey()
      if (disposed || !nextKey || !isOwnerCurrent(nextOwner)
        || !Number.isFinite(at) || !Number.isSafeInteger(nextSequence) || nextSequence < 1) return false
      if (owner === nextOwner && contextKey === nextKey && nextSequence <= sequence) return false
      owner = nextOwner
      contextKey = nextKey
      sequence = nextSequence
      arm(at)
      return true
    },
    wake,
    syncContext() {
      if (!current()) cancel()
    },
    cancelOwner(expectedOwner) {
      if (owner === expectedOwner) cancel()
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}

module.exports = { REMINDER_RECONCILE_MS, createReminderWakeupController }
