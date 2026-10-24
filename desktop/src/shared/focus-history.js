import { isFocusSnapshotCurrent } from './focus-session.js'

const FOCUS_DURATIONS = new Set([15, 25, 45].map((minutes) => minutes * 60000))
const DATE_CHECK_INTERVAL_MS = 60000

export function summarizeFocusHistory(history, now = Date.now()) {
  const summary = { todayCount: 0, todayMinutes: 0, recent: [] }
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || !Array.isArray(history)) return summary

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const earliest = new Date(today)
  // Calendar dates, rather than 24-hour blocks, also handle daylight saving changes.
  earliest.setDate(earliest.getDate() - 6)
  const seen = new Set()
  const entries = history.filter((entry) => (
    entry && typeof entry.id === 'string' && entry.id.trim()
    && FOCUS_DURATIONS.has(entry.durationMs)
    && Number.isFinite(entry.completedAt)
    && entry.completedAt >= earliest.getTime() && entry.completedAt <= now
  )).sort((left, right) => right.completedAt - left.completedAt)

  let todayDurationMs = 0
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    if (entry.completedAt >= today.getTime()) {
      summary.todayCount += 1
      todayDurationMs += entry.durationMs
    }
    if (summary.recent.length < 3) {
      summary.recent.push({
        id: entry.id,
        intention: typeof entry.intention === 'string' ? entry.intention.trim().slice(0, 80) : '',
        durationMs: entry.durationMs,
        completedAt: entry.completedAt,
      })
    }
  }
  summary.todayMinutes = todayDurationMs / 60000
  return summary
}

export function getFocusHistorySummary(snapshot, context, now = Date.now()) {
  return summarizeFocusHistory(isFocusSnapshotCurrent(snapshot, context) ? snapshot?.history : [], now)
}

export function getFocusHistoryRefreshDelay(now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return DATE_CHECK_INTERVAL_MS
  const tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  // Refresh at midnight even while idle; the periodic check also handles clock/timezone changes.
  const remaining = tomorrow.getTime() - now + 1
  return Number.isFinite(remaining) ? Math.max(1, Math.min(DATE_CHECK_INTERVAL_MS, remaining)) : DATE_CHECK_INTERVAL_MS
}
