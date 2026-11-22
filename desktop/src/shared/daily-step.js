import { normalizeApiBaseUrl } from './api-base-url.js'

export const DAILY_STEP_TITLE_LENGTH = 80
const STORAGE_PREFIX = 'detachym.daily-step.v1:'
const COMPLETED_HISTORY_DAYS = 7
const UTC_DAY_MS = 86_400_000
const FOCUS_REVISION = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

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

function shiftDateLabel(date, days) {
  const millis = parseDateLabel(date)
  if (millis === null) return null
  const shifted = new Date(millis + days * UTC_DAY_MS).toISOString().split('T')[0]
  return shifted.length === 10 ? shifted : null
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
  return step ? { date: record.date, ...step, ...readFocusRevision(record) } : null
}

function getSavedTomorrowPlan(record) {
  const plan = record?.tomorrowPlan
  const title = getDailyStepTitle(plan?.title)
  return title && parseDateLabel(plan.date) !== null && (plan.completed === undefined || plan.completed === false)
    ? { date: plan.date, title, ...readFocusRevision(plan) }
    : null
}

function readFocusRevision(record) {
  return typeof record.focusRevision === 'string' && FOCUS_REVISION.test(record.focusRevision)
    ? { focusRevision: record.focusRevision }
    : {}
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

function saveDailyStepRecord(storage, storageKey, slot, history, tomorrowPlan) {
  const completedHistory = newestCompletions(history).slice(0, COMPLETED_HISTORY_DAYS)
  if (!slot && !completedHistory.length && !tomorrowPlan) {
    storage.removeItem(storageKey)
    return
  }
  const record = { ...slot, completedHistory }
  if (tomorrowPlan) record.tomorrowPlan = tomorrowPlan
  storage.setItem(storageKey, JSON.stringify(record))
}

function getDailyStepData(record) {
  const slot = getSavedSlot(record)
  return { slot, history: getCompletedHistory(record, slot), tomorrowPlan: getSavedTomorrowPlan(record) }
}

function findDailyStep({ slot, history, tomorrowPlan }, date) {
  if (slot?.date === date) return slot
  const title = history.get(date)
  if (title) return { title, completed: true }
  return tomorrowPlan?.date === date ? { ...tomorrowPlan, completed: false } : null
}

export function readDailyStep(storageKey, date, getStorage = getLocalStorage) {
  if (!storageKey || parseDateLabel(date) === null) return null
  return normalizeStep(findDailyStep(getDailyStepData(readSavedRecord(storageKey, getStorage)), date))
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
  const previous = shiftDateLabel(date, -1)
  if (!storageKey || !previous) return null
  const candidate = readDailyStep(storageKey, previous, getStorage)
  return candidate?.completed === false ? candidate : null
}

export function readTomorrowDailyStep(storageKey, date, getStorage = getLocalStorage) {
  const tomorrow = shiftDateLabel(date, 1)
  if (!storageKey || !tomorrow) return null
  const record = readSavedRecord(storageKey, getStorage)
  const plan = getSavedTomorrowPlan(record)
  if (plan?.date !== tomorrow) return null
  const slot = getSavedSlot(record)
  if (slot?.date === tomorrow || getCompletedHistory(record, slot).has(tomorrow)) return null
  return { date: plan.date, title: plan.title }
}

function saveDailyStepChange(storage, storageKey, date, step, { slot, history, tomorrowPlan }) {
  if (step?.completed) history.set(date, step.title)
  else history.delete(date)
  const retainedSlot = slot?.date === date ? null : slot
  const nextSlot = step ? { date, ...step } : retainedSlot
  saveDailyStepRecord(storage, storageKey, nextSlot, history, tomorrowPlan?.date === date ? null : tomorrowPlan)
}

export function writeDailyStep(storageKey, date, value, getStorage = getLocalStorage) {
  const step = normalizeStep(value)
  if (!storageKey || parseDateLabel(date) === null || (value !== null && !step)) return false
  try {
    const storage = getStorage()
    if (!storage) return false
    saveDailyStepChange(storage, storageKey, date, step, getDailyStepData(parseSavedRecord(storage.getItem(storageKey))))
    return true
  } catch {
    return false
  }
}

export function prepareDailyStepFocus(storageKey, date, title, getStorage = getLocalStorage) {
  if (!storageKey || parseDateLabel(date) === null) return null
  try {
    const storage = getStorage()
    const { slot, history, tomorrowPlan } = getDailyStepData(parseSavedRecord(storage.getItem(storageKey)))
    const step = findDailyStep({ slot, history, tomorrowPlan }, date)
    if (step?.completed !== false || step.title !== title) return null
    // Existing steps acquire an identity only when explicitly opened in Focus.
    if (step.focusRevision) return { date, revision: step.focusRevision }
    const revision = globalThis.crypto.randomUUID()
    const fromSlot = slot?.date === date
    saveDailyStepRecord(storage, storageKey, fromSlot ? { ...slot, focusRevision: revision } : slot, history,
      fromSlot ? tomorrowPlan : { ...tomorrowPlan, focusRevision: revision })
    return { date, revision }
  } catch {
    return null
  }
}

function matchesDailyStepFocus(step, origin) {
  return step?.completed === false && typeof origin?.revision === 'string' && step.focusRevision === origin.revision
}

export function isDailyStepFocusCurrent(storageKey, origin, now = Date.now(), getStorage = getLocalStorage) {
  if (!storageKey || !origin?.date || getDailyStepDate(now) !== origin.date) return false
  const data = getDailyStepData(readSavedRecord(storageKey, getStorage))
  return matchesDailyStepFocus(findDailyStep(data, origin.date), origin)
}

export function completeDailyStepFromFocus(storageKey, origin, now = Date.now(), getStorage = getLocalStorage) {
  if (!storageKey || !origin?.date || getDailyStepDate(now) !== origin.date) return 'stale'
  try {
    const storage = getStorage()
    const data = getDailyStepData(parseSavedRecord(storage.getItem(storageKey)))
    const step = findDailyStep(data, origin.date)
    if (!matchesDailyStepFocus(step, origin)) return 'stale'
    saveDailyStepChange(storage, storageKey, origin.date, { title: step.title, completed: true }, data)
    return 'completed'
  } catch {
    return 'failed'
  }
}

export function writeTomorrowDailyStep(storageKey, date, titleOrNull, getStorage = getLocalStorage) {
  const tomorrow = shiftDateLabel(date, 1)
  const title = getDailyStepTitle(titleOrNull)
  if (!storageKey || !tomorrow || (titleOrNull !== null && !title)) return false
  try {
    const storage = getStorage()
    if (!storage) return false
    const record = parseSavedRecord(storage.getItem(storageKey))
    const plan = getSavedTomorrowPlan(record)
    if (titleOrNull === null && plan?.date !== tomorrow) return true

    const slot = getSavedSlot(record)
    const history = getCompletedHistory(record, slot)
    // If the clock moved back, a saved step or completion already belongs to this date.
    if (title && (slot?.date === tomorrow || history.has(tomorrow))) return false
    saveDailyStepRecord(storage, storageKey, slot, history, title ? { date: tomorrow, title } : null)
    return true
  } catch {
    return false
  }
}
