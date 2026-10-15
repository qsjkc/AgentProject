import { createAuthContextChangedError } from './pet-account-context.js'

export function createLoginOperations(cancelAttempt) {
  let mounted = false
  let pending = null
  const cancel = (attempt) => {
    if (attempt) void Promise.resolve(cancelAttempt(attempt)).catch(() => {})
  }
  const invalidate = () => {
    const previous = pending
    pending = null
    previous?.abort.abort(createAuthContextChangedError())
    cancel(previous?.attempt)
  }
  return {
    mount() { invalidate(); mounted = true },
    unmount() { mounted = false; invalidate() },
    invalidate,
    begin() {
      if (!mounted || pending) return null
      const operation = { attempt: null, abort: new AbortController() }
      pending = operation
      const isCurrent = () => mounted && pending === operation
      return {
        isCurrent,
        signal: operation.abort.signal,
        assertCurrent() { if (!isCurrent()) throw createAuthContextChangedError() },
        ownAttempt(attempt) {
          if (!isCurrent()) { cancel(attempt); throw createAuthContextChangedError() }
          if (!attempt) throw createAuthContextChangedError()
          operation.attempt = attempt
          return attempt
        },
        finish() {
          if (pending === operation) pending = null
          cancel(operation.attempt)
        },
      }
    },
  }
}
