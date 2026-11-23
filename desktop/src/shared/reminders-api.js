import { desktopApiRequest } from './api'
import { REMINDER_RECONCILE_MS } from './reminder-poll.js'

export function createReminder(payload, operationContext) {
  return desktopApiRequest('/reminders', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, operationContext)
}

export function getPendingReminders(petType, dueBefore = null, triggered = null, operationContext = null) {
  const params = new URLSearchParams({ pet_type: petType, status: 'pending' })
  if (dueBefore) {
    params.set('due_before', dueBefore.toISOString())
  }
  if (typeof triggered === 'boolean') {
    params.set('triggered', String(triggered))
  }
  return desktopApiRequest(`/reminders?${params.toString()}`, {}, operationContext)
}

export function getPendingReminderSummary(petType, operationContext) {
  const params = new URLSearchParams({ pet_type: petType })
  return desktopApiRequest(`/reminders/pending-summary?${params.toString()}`, {}, operationContext)
}

export function getReminderPollSnapshot(petType, operationContext) {
  const legacyDueBefore = Date.now() + REMINDER_RECONCILE_MS
  const params = new URLSearchParams({
    pet_type: petType,
    status: 'pending',
    triggered: 'false',
    due_before: new Date(legacyDueBefore).toISOString(),
    lookahead_seconds: String(REMINDER_RECONCILE_MS / 1000),
  })
  return desktopApiRequest(`/reminders?${params.toString()}`, {}, operationContext, (reminders, headers) => {
    const serverTime = Date.parse(headers.get('X-Detachym-Reminder-Time') ?? '')
    // Older services still apply due_before and retain their local-clock behavior.
    return Number.isFinite(serverTime)
      ? { reminders, now: serverTime, dueBefore: serverTime + REMINDER_RECONCILE_MS }
      : { reminders, now: Date.now(), dueBefore: legacyDueBefore }
  })
}

export function completeReminder(reminderId, operationContext) {
  return desktopApiRequest(`/reminders/${reminderId}/complete`, {
    method: 'POST',
  }, operationContext)
}

export function retryReminderEmail(reminderId, operationContext) {
  return desktopApiRequest(`/reminders/${reminderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ email_enabled: true }),
  }, operationContext)
}

export function skipReminderOccurrence(reminderId, operationContext) {
  return desktopApiRequest(`/reminders/${reminderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'canceled' }),
  }, operationContext)
}

export function getReminderSeries(petType, operationContext) {
  const params = new URLSearchParams({ pet_type: petType })
  return desktopApiRequest(`/reminder-series?${params.toString()}`, {}, operationContext)
}

export function pauseReminderSeries(seriesId, operationContext) {
  return desktopApiRequest(`/reminder-series/${seriesId}/pause`, {
    method: 'POST',
  }, operationContext)
}

export function resumeReminderSeries(seriesId, operationContext) {
  return desktopApiRequest(`/reminder-series/${seriesId}/resume`, {
    method: 'POST',
  }, operationContext)
}

export function cancelReminderSeries(seriesId, operationContext) {
  return desktopApiRequest(`/reminder-series/${seriesId}/cancel`, {
    method: 'POST',
  }, operationContext)
}

export function markReminderTriggered(reminderId, operationContext, expectedRemindAt) {
  const query = expectedRemindAt ? `?${new URLSearchParams({ expected_remind_at: expectedRemindAt })}` : ''
  return desktopApiRequest(`/reminders/${reminderId}/trigger${query}`, {
    method: 'POST',
  }, operationContext)
}
