import { normalizeApiBaseUrl } from './api-base-url.js'

export const DAILY_STEP_TITLE_LENGTH = 80
const STORAGE_PREFIX = 'detachym.daily-step.v1:'

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
  if (!Number.isFinite(local.getTime())) return null
  const month = String(local.getMonth() + 1).padStart(2, '0')
  const day = String(local.getDate()).padStart(2, '0')
  return `${local.getFullYear()}-${month}-${day}`
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

export function readDailyStep(storageKey, date, getStorage = getLocalStorage) {
  if (!storageKey || !date) return null
  try {
    const saved = JSON.parse(getStorage()?.getItem(storageKey) ?? 'null')
    return saved?.date === date ? normalizeStep(saved) : null
  } catch {
    return null
  }
}

export function readDailyStepCarryOver(storageKey, date, getStorage = getLocalStorage) {
  if (!storageKey || !date) return null
  // The key is already a local calendar date. Use UTC only for calendar arithmetic,
  // so DST and overnight offset changes do not shift which date counts as yesterday.
  const previous = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(previous.getTime())) return null
  previous.setUTCDate(previous.getUTCDate() - 1)
  const candidate = readDailyStep(storageKey, previous.toISOString().slice(0, 10), getStorage)
  return candidate?.completed === false ? candidate : null
}

export function writeDailyStep(storageKey, date, value, getStorage = getLocalStorage) {
  const step = normalizeStep(value)
  if (!storageKey || !date || (value !== null && !step)) return false
  try {
    const storage = getStorage()
    if (!storage) return false
    if (step) storage.setItem(storageKey, JSON.stringify({ date, ...step }))
    else storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}
