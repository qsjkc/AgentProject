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

export function markReminderTriggered(reminderId) {
  return desktopApiRequest(`/reminders/${reminderId}/trigger`, {
    method: 'POST',
  })
}
