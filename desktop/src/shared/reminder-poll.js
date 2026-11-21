import { AUTH_CONTEXT_CHANGED_CODE } from './pet-account-context.js'

export const REMINDER_RECONCILE_MS = 30_000
export const REMINDER_BACKLOG_DELAY_MS = 250

const REMINDER_RECEIPTS_KEY = 'detachym.pending-reminder-receipts.v1'

function getReminderReceiptKey({ server, userId, petType }, reminder) {
  if (!server || !reminder || reminder.user_id !== userId || reminder.pet_type !== petType
    || !Number.isSafeInteger(reminder.id) || reminder.id <= 0
    || !Number.isFinite(Date.parse(reminder.remind_at))) return null
  // Keep the server's UTC timestamp verbatim, including any sub-millisecond precision.
  return JSON.stringify([server, userId, petType, reminder.id, reminder.remind_at])
}

export function createReminderDeliveryController({ getStorage = () => globalThis.localStorage, now = Date.now } = {}) {
  const presented = new Map()
  try {
    const saved = JSON.parse(getStorage()?.getItem(REMINDER_RECEIPTS_KEY) || '[]')
    for (const record of saved) {
      if (Array.isArray(record) && record.length === 5 && Number.isFinite(Date.parse(record[4]))) {
        presented.set(JSON.stringify(record), record)
      }
    }
  } catch {
    // In restricted profiles the current renderer can still remember delivery.
  }

  function persist() {
    try {
      getStorage()?.setItem(REMINDER_RECEIPTS_KEY, JSON.stringify([...presented.values()]))
    } catch {
      // Keep the receipt in memory so this renderer can still retry safely.
    }
  }

  return {
    reconcile({ server, userId, petType }, reminders, dueBefore) {
      if (!Array.isArray(reminders)) return
      const scope = { server, userId, petType }
      const pending = new Set(reminders.map((reminder) => getReminderReceiptKey(scope, reminder)))
      let changed = false
      for (const [key, [receiptServer, receiptUser, receiptPet, , deadline]] of presented) {
        // A fresh untriggered list can also confirm a POST whose reply was lost.
        if (receiptServer === server && receiptUser === userId && receiptPet === petType
          && Date.parse(deadline) <= dueBefore && !pending.has(key)) {
          presented.delete(key)
          changed = true
        }
      }
      if (changed) persist()
    },
    async deliver({ context, reminder, present, acknowledge }) {
      const key = getReminderReceiptKey(context, reminder)
      if (!key) return { retry: true }
      if (!presented.has(key)) {
        await present(() => {
          if (presented.has(key)) return
          presented.set(key, JSON.parse(key))
          persist()
        })
      }
      if (!presented.has(key)) return { retry: true }
      if (!await acknowledge()) return
      presented.delete(key)
      persist()
      return { nextAt: now() + REMINDER_BACKLOG_DELAY_MS }
    },
  }
}

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

export function isTransientReminderReadError(error) {
  return error?.code === 'REQUEST_TIMEOUT' || error?.status === 408
    || (error?.status >= 500 && error.status < 600)
    || (error instanceof TypeError && error.message === 'Failed to fetch')
}

// Events that arrive during a request must cause a fresh read afterwards.
// Reconnecting permits one early read retry. Other failures keep their cooldown.
export function createReminderPollController({ poll, schedule, onError = () => {}, now = Date.now }) {
  let pending = null
  let requested = null
  let disposed = false
  let retryAt = 0
  let retryOnReconnect = false
  let contextRetries = 0

  function request({ reconnected = false } = {}) {
    if (disposed) return Promise.resolve()
    if (pending) {
      if (requested !== 'reconnect') requested = reconnected ? 'reconnect' : 'refresh'
      return pending
    }
    let retriedOnReconnect = now() < retryAt
    if (retriedOnReconnect && !(reconnected && retryOnReconnect)) return Promise.resolve(schedule(retryAt))
    pending = Promise.resolve().then(async () => {
      while (!disposed) {
        requested = null
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
          retryOnReconnect = result.retryOnReconnect === true && !retriedOnReconnect
          if (!retryOnReconnect || requested !== 'reconnect') requested = null
        } else {
          retryAt = 0
          retryOnReconnect = false
        }
        if (!requested) {
          const nextAt = result?.retry ? retryAt : result?.nextAt
          await schedule(Number.isFinite(nextAt) ? nextAt : now() + REMINDER_RECONCILE_MS)
        }
        if (!requested || disposed) return
        retriedOnReconnect = now() < retryAt
        if (retriedOnReconnect && !(retryOnReconnect && requested === 'reconnect')) return
      }
    }).finally(() => { pending = null })
    return pending
  }

  return {
    request,
    dispose() { disposed = true; requested = null },
  }
}
