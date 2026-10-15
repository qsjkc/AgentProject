export const VOICE_START_CANCELLED = 'VOICE_START_CANCELLED'

export function createVoiceStartCancelledError() {
  const error = new Error('语音连接已取消。')
  error.code = VOICE_START_CANCELLED
  return error
}

export function createVoiceSdkLoader(importSdk = () => import('@volcengine/rtc')) {
  let pending = null
  return function loadSdk() {
    if (!pending) {
      const request = Promise.resolve().then(importSdk)
      pending = request
      void request.catch(() => {
        if (pending === request) pending = null
      })
    }
    return pending
  }
}

export const loadVoiceSdk = createVoiceSdkLoader()

// Invalidating a startup cancels its waiters without cancelling the shared SDK load.
// A later voice request can reuse that load, but cannot reuse the old operation.
export function createVoiceStartGuard() {
  let generation = 0
  let destroyed = false
  const waiters = new Set()
  const isCurrent = (expected) => !destroyed && generation === expected
  const assertCurrent = (expected) => {
    if (!isCurrent(expected)) throw createVoiceStartCancelledError()
  }
  const cancel = () => {
    generation += 1
    for (const reject of waiters) reject(createVoiceStartCancelledError())
    waiters.clear()
  }

  return {
    capture() {
      assertCurrent(generation)
      return generation
    },
    isCurrent,
    assertCurrent,
    waitFor(value, expected) {
      return new Promise((resolve, reject) => {
        const rejectCancelled = () => reject(createVoiceStartCancelledError())
        waiters.add(rejectCancelled)
        Promise.resolve(value).then(
          (result) => {
            waiters.delete(rejectCancelled)
            if (isCurrent(expected)) resolve(result)
            else rejectCancelled()
          },
          (error) => {
            waiters.delete(rejectCancelled)
            if (isCurrent(expected)) reject(error)
            else rejectCancelled()
          },
        )
        if (!isCurrent(expected)) {
          waiters.delete(rejectCancelled)
          rejectCancelled()
        }
      })
    },
    cancel,
    destroy() {
      destroyed = true
      cancel()
    },
  }
}
