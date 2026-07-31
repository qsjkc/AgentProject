import { ANIMATION_ACTIONS } from './pet-animation-state.js'

export const COMPANION_MODES = {
  OFF: 'off',
  LOW: 'low',
  STANDARD: 'standard',
}

export const COMPANION_EVENT_TYPES = {
  DAILY_GREETING: 'daily_greeting',
  WELCOME_BACK: 'welcome_back',
  PROACTIVE_MOMENT: 'proactive_moment',
}

export const DEFAULT_COMPANION_SETTINGS = {
  mode: COMPANION_MODES.STANDARD,
  quietHoursStart: 23,
  quietHoursEnd: 8,
}

export const DEFAULT_COMPANION_STATE = {
  dayKey: '',
  proactiveCount: 0,
  lastEventAt: null,
  lastEventType: null,
  lastDailyGreetingDay: '',
  recentCopyIds: [],
  wasAway: false,
  awaySince: null,
  currentMood: 'relaxed',
}

export const COMPANION_MOODS = [
  'relaxed',
  'expectant',
  'happy',
  'sleepy',
  'focused',
]

const MODE_LIMITS = {
  [COMPANION_MODES.LOW]: {
    maxEventsPerDay: 2,
    minimumGapMs: 150 * 60 * 1000,
  },
  [COMPANION_MODES.STANDARD]: {
    maxEventsPerDay: 4,
    minimumGapMs: 60 * 60 * 1000,
  },
}

const AWAY_IDLE_SECONDS = 30 * 60
const RETURNED_IDLE_SECONDS = 60
const ACTIVE_IDLE_SECONDS = 2 * 60
const RETURN_EVENT_MINIMUM_GAP_MS = 20 * 60 * 1000
const MOOD_DECAY_MS = 20 * 60 * 1000
const RECENT_COPY_LIMIT = 6

function clampHour(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(23, Math.max(0, Math.round(number)))
}

function normalizeTimestamp(value) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function normalizeCompanionSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const mode = Object.values(COMPANION_MODES).includes(source.mode)
    ? source.mode
    : DEFAULT_COMPANION_SETTINGS.mode

  return {
    mode,
    quietHoursStart: clampHour(
      source.quietHoursStart,
      DEFAULT_COMPANION_SETTINGS.quietHoursStart,
    ),
    quietHoursEnd: clampHour(
      source.quietHoursEnd,
      DEFAULT_COMPANION_SETTINGS.quietHoursEnd,
    ),
  }
}

export function normalizeCompanionState(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    dayKey: typeof source.dayKey === 'string' ? source.dayKey : '',
    proactiveCount: Math.max(0, Math.floor(Number(source.proactiveCount) || 0)),
    lastEventAt: normalizeTimestamp(source.lastEventAt),
    lastEventType: Object.values(COMPANION_EVENT_TYPES).includes(source.lastEventType)
      ? source.lastEventType
      : null,
    lastDailyGreetingDay:
      typeof source.lastDailyGreetingDay === 'string'
        ? source.lastDailyGreetingDay
        : '',
    recentCopyIds: Array.isArray(source.recentCopyIds)
      ? source.recentCopyIds
          .filter((item) => typeof item === 'string' && item)
          .slice(-RECENT_COPY_LIMIT)
      : [],
    wasAway: Boolean(source.wasAway),
    awaySince: normalizeTimestamp(source.awaySince),
    currentMood: COMPANION_MOODS.includes(source.currentMood)
      ? source.currentMood
      : DEFAULT_COMPANION_STATE.currentMood,
  }
}

export function getCompanionDayKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getCompanionTimeContext(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  const hour = date.getHours()
  if (hour >= 8 && hour < 11) {
    return 'morning'
  }
  if (hour >= 11 && hour < 14) {
    return 'midday'
  }
  if (hour >= 14 && hour < 18) {
    return 'afternoon'
  }
  if (hour >= 18 && hour < 22) {
    return 'evening'
  }
  return 'late_night'
}

export function isCompanionQuietTime(now, settings = DEFAULT_COMPANION_SETTINGS) {
  const normalized = normalizeCompanionSettings(settings)
  const hour = (now instanceof Date ? now : new Date(now)).getHours()
  const { quietHoursStart: start, quietHoursEnd: end } = normalized

  if (start === end) {
    return false
  }
  if (start < end) {
    return hour >= start && hour < end
  }
  return hour >= start || hour < end
}

function elapsedSince(timestamp, nowMs) {
  if (!timestamp) {
    return Number.POSITIVE_INFINITY
  }
  const previous = new Date(timestamp).getTime()
  return Number.isFinite(previous) ? Math.max(0, nowMs - previous) : Number.POSITIVE_INFINITY
}

function selectProactiveAction(timeContext, proactiveCount) {
  switch (timeContext) {
    case 'morning':
      return ANIMATION_ACTIONS.STRETCH
    case 'midday':
      return ANIMATION_ACTIONS.LOOK_AROUND
    case 'afternoon':
      return proactiveCount % 2 === 0
        ? ANIMATION_ACTIONS.RUN
        : ANIMATION_ACTIONS.LOOK_AROUND
    case 'evening':
      return ANIMATION_ACTIONS.STRETCH
    default:
      return ANIMATION_ACTIONS.YAWN
  }
}

function getEventMood(eventType, timeContext) {
  if (eventType === COMPANION_EVENT_TYPES.WELCOME_BACK) {
    return 'happy'
  }
  if (timeContext === 'late_night') {
    return 'sleepy'
  }
  if (timeContext === 'afternoon') {
    return 'focused'
  }
  if (timeContext === 'midday') {
    return 'expectant'
  }
  return 'relaxed'
}

function completeCompanionEvent(state, eventType, action, timeContext, now) {
  const dayKey = getCompanionDayKey(now)
  return {
    event: {
      type: eventType,
      action,
      mood: getEventMood(eventType, timeContext),
      timeContext,
    },
    state: {
      ...state,
      dayKey,
      proactiveCount: state.proactiveCount + 1,
      lastEventAt: now.toISOString(),
      lastEventType: eventType,
      currentMood: getEventMood(eventType, timeContext),
      lastDailyGreetingDay:
        eventType === COMPANION_EVENT_TYPES.DAILY_GREETING ||
        eventType === COMPANION_EVENT_TYPES.WELCOME_BACK
          ? dayKey
          : state.lastDailyGreetingDay,
      wasAway: false,
      awaySince: null,
    },
  }
}

export function evaluateCompanionOpportunity({
  now = new Date(),
  idleSeconds = 0,
  settings = DEFAULT_COMPANION_SETTINGS,
  state = DEFAULT_COMPANION_STATE,
} = {}) {
  const currentTime = now instanceof Date ? now : new Date(now)
  const nowMs = currentTime.getTime()
  const normalizedSettings = normalizeCompanionSettings(settings)
  const normalizedState = normalizeCompanionState(state)
  const dayKey = getCompanionDayKey(currentTime)
  const timeContext = getCompanionTimeContext(currentTime)
  const numericIdleSeconds = Math.max(0, Number(idleSeconds) || 0)
  const nextState = {
    ...normalizedState,
    dayKey,
    proactiveCount:
      normalizedState.dayKey === dayKey ? normalizedState.proactiveCount : 0,
  }
  if (elapsedSince(nextState.lastEventAt, nowMs) >= MOOD_DECAY_MS) {
    nextState.currentMood = getEventMood(
      COMPANION_EVENT_TYPES.PROACTIVE_MOMENT,
      timeContext,
    )
  }

  if (numericIdleSeconds >= AWAY_IDLE_SECONDS) {
    return {
      event: null,
      state: {
        ...nextState,
        wasAway: true,
        awaySince:
          nextState.awaySince ||
          new Date(nowMs - numericIdleSeconds * 1000).toISOString(),
        currentMood: 'expectant',
      },
    }
  }

  const quiet = isCompanionQuietTime(currentTime, normalizedSettings)
  if (normalizedSettings.mode === COMPANION_MODES.OFF || quiet) {
    return {
      event: null,
      state: {
        ...nextState,
        wasAway: numericIdleSeconds > RETURNED_IDLE_SECONDS && nextState.wasAway,
        awaySince:
          numericIdleSeconds > RETURNED_IDLE_SECONDS ? nextState.awaySince : null,
        currentMood: quiet ? 'sleepy' : nextState.currentMood,
      },
    }
  }

  const limits = MODE_LIMITS[normalizedSettings.mode]
  if (!limits || nextState.proactiveCount >= limits.maxEventsPerDay) {
    return {
      event: null,
      state: {
        ...nextState,
        wasAway: numericIdleSeconds > RETURNED_IDLE_SECONDS && nextState.wasAway,
        awaySince:
          numericIdleSeconds > RETURNED_IDLE_SECONDS ? nextState.awaySince : null,
      },
    }
  }

  const eventGapMs = elapsedSince(nextState.lastEventAt, nowMs)
  if (nextState.wasAway && numericIdleSeconds <= RETURNED_IDLE_SECONDS) {
    if (eventGapMs >= RETURN_EVENT_MINIMUM_GAP_MS) {
      return completeCompanionEvent(
        nextState,
        COMPANION_EVENT_TYPES.WELCOME_BACK,
        ANIMATION_ACTIONS.WELCOME_BACK,
        timeContext,
        currentTime,
      )
    }
    return {
      event: null,
      state: {
        ...nextState,
        wasAway: false,
        awaySince: null,
      },
    }
  }

  if (nextState.lastDailyGreetingDay !== dayKey) {
    return completeCompanionEvent(
      nextState,
      COMPANION_EVENT_TYPES.DAILY_GREETING,
      selectProactiveAction(timeContext, nextState.proactiveCount),
      timeContext,
      currentTime,
    )
  }

  if (
    numericIdleSeconds <= ACTIVE_IDLE_SECONDS &&
    eventGapMs >= limits.minimumGapMs
  ) {
    return completeCompanionEvent(
      nextState,
      COMPANION_EVENT_TYPES.PROACTIVE_MOMENT,
      selectProactiveAction(timeContext, nextState.proactiveCount),
      timeContext,
      currentTime,
    )
  }

  return { event: null, state: nextState }
}

export function recordCompanionCopy(state, copyId) {
  const normalizedState = normalizeCompanionState(state)
  if (!copyId) {
    return normalizedState
  }
  return {
    ...normalizedState,
    recentCopyIds: [...normalizedState.recentCopyIds, copyId].slice(-RECENT_COPY_LIMIT),
  }
}

export function getCompanionStatusKey({
  now = new Date(),
  settings = DEFAULT_COMPANION_SETTINGS,
  state = DEFAULT_COMPANION_STATE,
} = {}) {
  const normalizedSettings = normalizeCompanionSettings(settings)
  const normalizedState = normalizeCompanionState(state)
  if (normalizedSettings.mode === COMPANION_MODES.OFF) {
    return 'off'
  }
  if (isCompanionQuietTime(now, normalizedSettings)) {
    return 'quiet'
  }
  if (normalizedState.wasAway) {
    return 'waiting_return'
  }
  return normalizedSettings.mode === COMPANION_MODES.LOW ? 'low_frequency' : 'standard'
}
