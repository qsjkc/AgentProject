export class VoiceConnectionCancelledError extends Error {
  constructor() {
    super('语音连接已取消。')
    this.name = 'VoiceConnectionCancelledError'
  }
}

export function isVoiceConnectionCancelled(error: unknown) {
  return error instanceof Error && error.name === 'VoiceConnectionCancelledError'
}

interface RtcResource {
  leave: () => Promise<void>
  destroy: () => void
}

interface BackendResource {
  stop: () => Promise<unknown>
}

export interface VoiceConnectionAttempt<Rtc extends RtcResource, Backend extends BackendResource> {
  previousCleanup: Promise<void>
  isCurrent: () => boolean
  assertCurrent: () => void
  ownRtc: (resource: Rtc) => Promise<void>
  ownBackend: (resource: Backend) => Promise<void>
  cleanup: () => Promise<void>
  readonly rtc: Rtc | null
  readonly backend: Backend | null
}

export function createVoiceSessionController<Rtc extends RtcResource, Backend extends BackendResource>(
  { cleanupTimeoutMs = 5_000 } = {},
) {
  let current: VoiceConnectionAttempt<Rtc, Backend> | null = null

  const begin = (isContextCurrent: () => boolean): VoiceConnectionAttempt<Rtc, Backend> => {
    const previousCleanup = current?.cleanup() ?? Promise.resolve()
    let active = true
    let rtc: Rtc | null = null
    let backend: Backend | null = null
    let rtcCleanup: Promise<void> | null = null
    let backendCleanup: Promise<void> | null = null

    const attempt: VoiceConnectionAttempt<Rtc, Backend> = {
      previousCleanup,
      isCurrent: () => active && current === attempt && isContextCurrent(),
      assertCurrent: () => {
        if (!attempt.isCurrent()) throw new VoiceConnectionCancelledError()
      },
      async ownRtc(resource) {
        rtc = resource
        if (!attempt.isCurrent()) {
          await attempt.cleanup()
          throw new VoiceConnectionCancelledError()
        }
      },
      async ownBackend(resource) {
        backend = resource
        if (!attempt.isCurrent()) {
          await attempt.cleanup()
          throw new VoiceConnectionCancelledError()
        }
      },
      async cleanup() {
        // Invalidate callbacks before the first await. Resources which arrive
        // after cancellation enter through ownRtc/ownBackend and are closed too.
        active = false
        if (rtc && !rtcCleanup) {
          const ownedRtc = rtc
          rtcCleanup = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                ownedRtc.leave(),
                new Promise<void>((resolve) => { timer = setTimeout(resolve, cleanupTimeoutMs) }),
              ])
            } finally {
              if (timer !== undefined) clearTimeout(timer)
              ownedRtc.destroy()
            }
          })()
        }
        if (backend && !backendCleanup) {
          const ownedBackend = backend
          backendCleanup = Promise.resolve().then(() => ownedBackend.stop()).then(() => undefined)
        }
        await Promise.allSettled([rtcCleanup, backendCleanup])
      },
      get rtc() { return rtc },
      get backend() { return backend },
    }
    current = attempt
    return attempt
  }

  return {
    begin,
    current: () => current,
    cancel: () => current?.cleanup() ?? Promise.resolve(),
  }
}
