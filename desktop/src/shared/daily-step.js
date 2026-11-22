import { normalizeApiBaseUrl } from './api-base-url.js'

export const DAILY_STEP_TITLE_LENGTH = 80
const STORAGE_PREFIX = 'detachym.daily-step.v1:'
const COMPLETED_HISTORY_DAYS = 7
const UTC_DAY_MS = 86_400_000

const getLocalStorage = () => globalThis.localStorage

export function getDailyStepStorageKey({ server, userId, petType, hasSession } = {}) {
  if (typeof userId !== 'string' && typeof userId !== 'number') return null
  const user = Number(userId)
  if (!hasSession || !Number.isSafeInteger(user) || user < 1 || !['cat', 'dog', 'pig'].includes(petType)) return null
  try {
    const normalizedServer = new URL(normalizeApiBaseUrl(server))
    if (normalizedServer.username || normalizedServer.password || normalizedServer.search || normalizedServer.hash) return null
    return `${STORAGE_PREFIX}${JSON.stringify([normalizedServer.href, user, petType])}`
  } catch {
    return null
  }
}

export function getDailyStepDate(now = Date.now()) {
  const local = new Date(now)
  const year = local.getFullYear()
  if (!Number.isFinite(local.getTime()) || year < 0 || year > 9999) return null
  const month = String(local.getMonth() + 1).padStart(2, '0')
  const day = String(local.getDate()).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${month}-${day}`
}

export function getDailyStepTitle(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return ''
  const title = value.trim()
  return title.length <= DAILY_STEP_TITLE_LENGTH ? title : ''
}

function normalizeStep(value) {
  const title = getDailyStepTitle(value?.title)
  return title && typeof value.completed === 'boolean' ? { title, completed: value.completed } : null
}

function parseDateLabel(date) {
  if (typeof date !== 'string' || date.length !== 10) return null
  // These labels name local calendar dates. Use UTC only for calendar arithmetic.
  const day = new Date(`${date}T00:00:00Z`)
  const millis = day.getTime()
  return Number.isFinite(millis) && day.toISOString().slice(0, 10) === date ? millis : null
}

function parseSavedRecord(raw) {
  try {
    return JSON.parse(raw ?? 'null')
  } catch {
    return null
  }
}

function readSavedRecord(storageKey, getStorage) {
  try {
    return parseSavedRecord(getStorage()?.getItem(storageKey))
  } catch {
    return null
  }
}

function getSavedSlot(record) {
  if (parseDateLabel(record?.date) === null) return null
  const step = normalizeStep(record)
  return step ? { date: record.date, ...step } : null
}

function getCompletedHistory(record, slot) {
  const history = new Map()
  if (Array.isArray(record?.completedHistory)) {
    for (const entry of record.completedHistory) {
      const title = getDailyStepTitle(entry?.title)
      if (title && parseDateLabel(entry.date) !== null && (entry.completed === undefined || entry.completed === true)) {
        history.set(entry.date, title)
      }
    }
  }
  // A valid v1 slot can be the only copy of a completion and wins on its date.
  if (slot?.completed) history.set(slot.date, slot.title)
  else if (slot) history.delete(slot.date)
  return history
}

function newestCompletions(history) {
  return Array.from(history, ([date, title]) => ({ date, title }))
    .sort((left, right) => right.date.localeCompare(left.date))
}

export function readDailyStep(storageKey, date, getStorage = getLocalStorage) {
  if (!storageKey || parseDateLabel(date) === null) return null
  const record = readSavedRecord(storageKey, getStorage)
  const slot = getSavedSlot(record)
  if (slot?.date === date) return { title: slot.title, completed: slot.completed }
  const title = getCompletedHistory(record, slot).get(date)
  return title ? { title, completed: true } : null
}

export function readCompletedDailySteps(storageKey, date, getStorage = getLocalStorage) {
  const end = parseDateLabel(date)
  if (!storageKey || end === null) return []
  const start = end - (COMPLETED_HISTORY_DAYS - 1) * UTC_DAY_MS
  const record = readSavedRecord(storageKey, getStorage)
  return newestCompletions(getCompletedHistory(record, getSavedSlot(record))).filter((entry) => {
    const day = parseDateLabel(entry.date)
    return day >= start && day <= end
  })
}

export function readDailyStepCarryOver(storageKey, date, getStorage = getLocalStorage) {
  const today = parseDateLabel(date)
  if (!storageKey || today === null) return null
  const previous = new Date(today - UTC_DAY_MS)
  const candidate = readDailyStep(storageKey, previous.toISOString().slice(0, 10), getStorage)
  return candidate?.completed === false ? candidate : null
}

export function writeDailyStep(storageKey, date, value, getStorage = getLocalStorage) {
  const step = normalizeStep(value)
  if (!storageKey || parseDateLabel(date) === null || (value !== null && !step)) return false
  try {
    const storage = getStorage()
    if (!storage) return false
    const record = parseSavedRecord(storage.getItem(storageKey))
    const slot = getSavedSlot(record)
    const history = getCompletedHistory(record, slot)
    if (step?.completed) history.set(date, step.title)
    else history.delete(date)

    const retainedSlot = slot?.date === date ? null : slot
    const nextSlot = step ? { date, ...step } : retainedSlot
    const completedHistory = newestCompletions(history).slice(0, COMPLETED_HISTORY_DAYS)
    if (nextSlot || completedHistory.length) {
      storage.setItem(storageKey, JSON.stringify({ ...nextSlot, completedHistory }))
    } else {
      storage.removeItem(storageKey)
    }
    return true
  } catch {
    return false
  }
}
