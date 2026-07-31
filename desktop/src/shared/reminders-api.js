import { desktopApiRequest } from './api'

export function createReminder(payload) {
  return desktopApiRequest('/reminders', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getPendingReminders(petType, dueBefore = null, triggered = null) {
  const params = new URLSearchParams({ pet_type: petType, status: 'pending' })
  if (dueBefore) {
    params.set('due_before', dueBefore.toISOString())
  }
  if (typeof triggered === 'boolean') {
    params.set('triggered', String(triggered))
  }
  return desktopApiRequest(`/reminders?${params.toString()}`)
}

export function getPendingReminderSummary(petType) {
  const params = new URLSearchParams({ pet_type: petType })
  return desktopApiRequest(`/reminders/pending-summary?${params.toString()}`)
}

export function completeReminder(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}/complete`, {
    method: 'POST',
  })
}

export function retryReminderEmail(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ email_enabled: true }),
  })
}

export function skipReminderOccurrence(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'canceled' }),
  })
}

export function getReminderSeries(petType) {
  const params = new URLSearchParams({ pet_type: petType })
  return desktopApiRequest(`/reminder-series?${params.toString()}`)
}

export function pauseReminderSeries(seriesId) {
  return desktopApiRequest(`/reminder-series/${seriesId}/pause`, {
    method: 'POST',
  })
}

export function resumeReminderSeries(seriesId) {
  return desktopApiRequest(`/reminder-series/${seriesId}/resume`, {
    method: 'POST',
  })
}

export function cancelReminderSeries(seriesId) {
  return desktopApiRequest(`/reminder-series/${seriesId}/cancel`, {
    method: 'POST',
  })
}

export function markReminderTriggered(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}/trigger`, {
    method: 'POST',
  })
}
