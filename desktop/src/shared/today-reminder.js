import { parseReminderReschedule } from './upcoming-reminders.js'

export const TODAY_REMINDER_PRESETS = Object.freeze([5, 15, 60])
export const TODAY_REMINDER_TITLE_LIMIT = 200

export function parseTodayReminderDraft(draft, now = Date.now()) {
  const title = typeof draft?.title === 'string' ? draft.title.trim() : ''
  if (!title || title.length > TODAY_REMINDER_TITLE_LIMIT) {
    return { ok: false, reason: 'invalid_title' }
  }

  if (!Number.isFinite(now)) return { ok: false, reason: 'invalid_time' }
  const { minutes, localTime } = draft
  if (minutes === null) {
    if (typeof localTime !== 'string') return { ok: false, reason: 'invalid_time' }
    const result = parseReminderReschedule(localTime, undefined, now)
    return result.ok ? { ...result, title } : result
  }

  if (!TODAY_REMINDER_PRESETS.includes(minutes)) return { ok: false, reason: 'invalid_time' }
  const reminderTime = new Date(now + minutes * 60_000)
  if (!Number.isFinite(reminderTime.getTime())) return { ok: false, reason: 'invalid_time' }
  return { ok: true, title, remindAt: reminderTime.toISOString() }
}
