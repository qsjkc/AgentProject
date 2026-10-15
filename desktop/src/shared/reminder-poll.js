export const REMINDER_RECONCILE_MS = 30_000
export const REMINDER_BACKLOG_DELAY_MS = 250

export function getReminderPollPlan(reminders, now) {
  const pending = (Array.isArray(reminders) ? reminders : [])
    .filter((reminder) => reminder?.status === 'pending' && !reminder.triggered_at
      && Number.isFinite(Date.parse(reminder.remind_at)))
    .sort((left, right) => Date.parse(left.remind_at) - Date.parse(right.remind_at) || left.id - right.id)
  const first = pending[0]
  const dueAt = first ? Date.parse(first.remind_at) : Infinity
  return {
    reminder: dueAt <= now ? first : null,
    nextAt: Math.min(now + REMINDER_RECONCILE_MS, dueAt),
  }
}

// Events that arrive during a request must cause a fresh read afterwards.
// A failed/muted delivery still backs off, even if events keep arriving.
export function createReminderPollController({ poll, schedule, onError = () => {}, now = Date.now }) {
  let pending = null
  let requested = false
  let disposed = false
  let retryAt = 0
  let contextRetries = 0

  function request() {
    if (disposed) return Promise.resolve()
    if (pending) {
      requested = true
      return pending
    }
    if (now() < retryAt) return Promise.resolve(schedule(retryAt))
    pending = Promise.resolve().then(async () => {
      do {
        requested = false
        let result
        try {
          result = await poll()
          contextRetries = 0
        } catch (error) {
          if (error?.code === AUTH_CONTEXT_CHANGED_CODE) {
            // Login/pet capability adoption can settle after the first render.
            // It is not a failed delivery: a new authorized event may retry
            // immediately, while unattended retries gradually slow down.
            contextRetries = Math.min(contextRetries + 1, 8)
            result = { nextAt: now() + Math.min(REMINDER_RECONCILE_MS, 250 * 2 ** (contextRetries - 1)) }
          } else {
            if (!disposed) onError(error)
            result = { retry: true }
          }
        }
        if (disposed) return
        if (result?.retry) {
          retryAt = now() + REMINDER_RECONCILE_MS
          requested = false
        }
        if (requested) continue
        const nextAt = result?.retry ? retryAt : result?.nextAt
        await schedule(Number.isFinite(nextAt) ? nextAt : now() + REMINDER_RECONCILE_MS)
      } while (requested && !disposed && now() >= retryAt)
    }).finally(() => { pending = null })
    return pending
  }

  return {
    request,
    dispose() { disposed = true; requested = false },
  }
}
import { AUTH_CONTEXT_CHANGED_CODE } from './pet-account-context.js'
