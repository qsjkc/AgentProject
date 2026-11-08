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
}) {
  let generation = 0
  let disposed = false
  let pending = null
  let status = 'idle'
  let lastStartedAt = -Infinity
  const publish = (nextStatus, error = null) => {
    status = nextStatus
    onStateChange({ status, error })
  }

  return {
    run({ automatic = false, context = null } = {}) {
      if (disposed) return Promise.resolve(false)
      if (pending) return pending
      if (automatic && (status !== 'retryable' || now() - lastStartedAt < retryCooldownMs)) {
        return Promise.resolve(false)
      }
      const operationGeneration = ++generation
      const isCurrent = () => !disposed && generation === operationGeneration
      lastStartedAt = now()
      // Defer execution so even synchronous callbacks cannot bypass single flight.
      const operation = Promise.resolve().then(async () => {
        let expected = context
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
          if (isCurrent()) publish(restored ? 'idle' : 'retryable')
          return Boolean(restored)
        } catch (error) {
          if (!isCurrent()) return false
          let current = false
          try { current = await isContextCurrent() } catch { /* IPC may be unavailable during shutdown. */ }
          if (isCurrent()) publish(current ? 'retryable' : 'idle', current ? error : null)
          return false
        } finally {
          if (pending === operation) pending = null
        }
      })
      pending = operation
      publish('recovering')
      return operation
    },
    invalidate() {
      generation += 1
      pending = null
      if (!disposed) publish('idle')
    },
    dispose() {
      disposed = true
      generation += 1
      pending = null
    },
  }
}
