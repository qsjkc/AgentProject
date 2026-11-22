import { isSessionSnapshotCurrent } from './pet-account-context.js'

const sameContext = (expected, current) => Boolean(
  expected?.server && expected.server === current?.server
  && expected.session?.token
  && isSessionSnapshotCurrent(expected.session, current?.session),
)

// Recovery never owns credentials. The existing API clears a rejected session;
// this controller only retries the same saved account and service.
export function createSessionRecoveryController({
  readContext,
  restore,
  onStateChange = () => {},
  now = Date.now,
  retryCooldownMs = 1500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let generation = 0
  let disposed = false
  let pending = null
  let status = 'idle'
  let lastStartedAt = -Infinity
  let retryContext = null
  let onlineQueued = false
  let onlineTimer = null
  const clearOnlineRetry = () => {
    if (onlineTimer !== null) clearTimer(onlineTimer)
    onlineTimer = null
    onlineQueued = false
  }
  const scheduleOnlineRetry = () => {
    if (!onlineQueued || onlineTimer !== null || !retryContext) return
    const scheduledGeneration = generation
    onlineTimer = setTimer(() => {
      if (generation !== scheduledGeneration) return
      onlineTimer = null
      void controller.run({ automatic: true, online: true })
    }, Math.max(0, lastStartedAt + retryCooldownMs - now()))
  }
  const publish = (nextStatus, error = null, expected = null) => {
    status = nextStatus
    retryContext = nextStatus === 'retryable' ? { server: expected.server, session: { ...expected.session } } : null
    onStateChange({ status, error })
  }

  const controller = {
    run({ automatic = false, context = null, online = false } = {}) {
      if (disposed) return Promise.resolve(false)
      const fromOnline = automatic && online
      if (pending) {
        if (fromOnline && !pending.fromOnline) onlineQueued = true
        return pending.promise
      }
      if (automatic && status !== 'retryable') return Promise.resolve(false)
      if (automatic && now() - lastStartedAt < retryCooldownMs) {
        if (fromOnline) {
          onlineQueued = true
          scheduleOnlineRetry()
        }
        return Promise.resolve(false)
      }
      const initialContext = fromOnline ? retryContext : context
      clearOnlineRetry()
      const operationGeneration = ++generation
      const isCurrent = () => !disposed && generation === operationGeneration
      lastStartedAt = now()
      // Defer execution so even synchronous callbacks cannot bypass single flight.
      const operation = Promise.resolve().then(async () => {
        let expected = initialContext
        const isContextCurrent = async () => {
          const current = await readContext()
          return isCurrent() && sameContext(expected, current)
        }
        try {
          expected ??= await readContext()
          if (!isCurrent()) return false
          if (!expected?.session?.token || !expected?.server || !await isContextCurrent()) {
            if (isCurrent()) publish('idle')
            return false
          }
          const restored = await restore(expected, { isCurrent, isContextCurrent })
          if (!await isContextCurrent()) {
            if (isCurrent()) publish('idle')
            return false
          }
          if (isCurrent()) publish(restored ? 'idle' : 'retryable', null, expected)
          return Boolean(restored)
        } catch (error) {
          if (!isCurrent()) return false
          let current = false
          try { current = await isContextCurrent() } catch { /* IPC may be unavailable during shutdown. */ }
          if (isCurrent()) publish(current ? 'retryable' : 'idle', current ? error : null, expected)
          return false
        } finally {
          if (pending?.promise === operation) {
            pending = null
            if (status === 'retryable') scheduleOnlineRetry()
            else clearOnlineRetry()
          }
        }
      })
      pending = { promise: operation, fromOnline }
      publish('recovering')
      return operation
    },
    invalidate() {
      generation += 1
      pending = null
      clearOnlineRetry()
      if (!disposed) publish('idle')
    },
    dispose() {
      disposed = true
      generation += 1
      pending = null
      clearOnlineRetry()
      retryContext = null
    },
  }
  return controller
}
