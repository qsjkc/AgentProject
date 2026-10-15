export function getUpcomingOneTimeReminders(items, context) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.status === 'pending'
      && item.recurrence_type === 'once'
      && !item.series_id
      && !item.triggered_at
      && Number(item.user_id) === Number(context?.userId)
      && item.pet_type === context?.petType
      && Number.isFinite(Date.parse(item.remind_at)))
    .sort((left, right) => Date.parse(left.remind_at) - Date.parse(right.remind_at) || left.id - right.id)
}

export function toReminderLocalInput(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function parseReminderReschedule(value, originalTime, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return { ok: false, reason: 'invalid_time' }
  }
  // An untouched minute input must retain seconds and the original DST fold.
  const original = new Date(originalTime)
  const date = Number.isFinite(original.getTime()) && value === toReminderLocalInput(originalTime)
    ? original
    : new Date(value)
  // Reject invalid calendar dates and local clocks skipped by a DST transition.
  if (!Number.isFinite(date.getTime()) || toReminderLocalInput(date) !== value) {
    return { ok: false, reason: 'invalid_time' }
  }
  if (date.getTime() <= Number(now)) return { ok: false, reason: 'past_time' }
  return { ok: true, remindAt: date.toISOString() }
}
