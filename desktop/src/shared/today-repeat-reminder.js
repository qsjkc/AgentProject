import { getBrowserTimeZone } from './reminder-recurrence.js'
import { parseReminderReschedule, toReminderLocalInput } from './upcoming-reminders.js'

const UTC_DAY_MS = 86_400_000

export function parseTodayRepeatReminder(draft, now = Date.now()) {
  const { repeat, clock } = draft ?? {}
  if (
    (repeat !== 'daily' && repeat !== 'weekdays')
    || typeof clock !== 'string'
    || clock.length !== 5
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)
    || !Number.isFinite(now)
  ) {
    return { ok: false, reason: 'invalid_time' }
  }

  // Advance the local date label independently of changes to the device's UTC offset.
  const localDay = toReminderLocalInput(now).slice(0, 10)
  const calendarStart = Date.parse(`${localDay}T00:00:00Z`)
  if (!Number.isFinite(calendarStart)) return { ok: false, reason: 'invalid_time' }

  for (let offset = 0; offset < 8; offset += 1) {
    const calendarDay = new Date(calendarStart + offset * UTC_DAY_MS)
    const weekday = calendarDay.getUTCDay()
    if (repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue

    // The API derives the rule's clock from its first instant. Skip a DST gap
    // here so the series retains the selected clock time.
    const day = calendarDay.toISOString().split('T')[0]
    const result = parseReminderReschedule(`${day}T${clock}`, undefined, now)
    if (result.ok) {
      return { ...result, recurrenceType: repeat, recurrenceTimezone: getBrowserTimeZone() }
    }
  }

  return { ok: false, reason: 'invalid_time' }
}
