const RENDERER_TELEMETRY_ROLES = Object.freeze([
  'pet',
  'main-panel',
  'quick-chat',
])

const RENDERER_TELEMETRY_LIMITS = Object.freeze({
  MAX_DEPTH: 5,
  MAX_OBJECT_KEYS: 40,
  MAX_TOTAL_KEYS: 160,
  MAX_ARRAY_LENGTH: 24,
  MAX_STRING_LENGTH: 500,
  MAX_EVENT_LENGTH: 100,
})

const RENDERER_TELEMETRY_MARKERS = Object.freeze({
  REDACTED: '[REDACTED]',
  CIRCULAR: '[CIRCULAR]',
  MAX_DEPTH: '[MAX_DEPTH]',
  MAX_KEYS: '[MAX_KEYS]',
  MAX_ARRAY_LENGTH: '[MAX_ARRAY_LENGTH]',
  TRUNCATED: '[TRUNCATED]',
  UNAVAILABLE: '[UNAVAILABLE]',
  UNSUPPORTED: '[UNSUPPORTED]',
})

const RENDERER_HEARTBEAT_EVENT = 'renderer-heartbeat'
const TRUNCATION_KEY = '__telemetry_truncated__'

const SENSITIVE_KEY_PATTERN = /(?:token|jwt|bearer|capabilit(?:y|ies)|authoritative|expected[\s_-]*context|authorization|secret|password|credential|api[\s_-]*key|cookie)/i
const SENSITIVE_STRING_PATTERN = /(?:token|jwt|bearer|capabilit(?:y|ies)|authoritative|authorization|secret|password|credential|cookie|expected[\s_-]*context|api[\s_-]*key|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})/i

function isAllowedRendererRole(role) {
  return RENDERER_TELEMETRY_ROLES.includes(role)
}

function truncateString(value) {
  if (value.length <= RENDERER_TELEMETRY_LIMITS.MAX_STRING_LENGTH) {
    return value
  }
  const marker = RENDERER_TELEMETRY_MARKERS.TRUNCATED
  return `${value.slice(0, RENDERER_TELEMETRY_LIMITS.MAX_STRING_LENGTH - marker.length)}${marker}`
}

function sanitizeString(value) {
  if (SENSITIVE_STRING_PATTERN.test(value)) {
    return RENDERER_TELEMETRY_MARKERS.REDACTED
  }
  return truncateString(value)
}

function defineSafeValue(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

function sanitizeValue(value, depth, state) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (typeof value === 'bigint') {
    return sanitizeString(value.toString())
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return RENDERER_TELEMETRY_MARKERS.UNSUPPORTED
  }
  if (depth >= RENDERER_TELEMETRY_LIMITS.MAX_DEPTH) {
    return RENDERER_TELEMETRY_MARKERS.MAX_DEPTH
  }
  if (state.seen.has(value)) {
    return RENDERER_TELEMETRY_MARKERS.CIRCULAR
  }

  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const isTruncated = value.length > RENDERER_TELEMETRY_LIMITS.MAX_ARRAY_LENGTH
      const itemLimit = isTruncated
        ? RENDERER_TELEMETRY_LIMITS.MAX_ARRAY_LENGTH - 1
        : value.length
      const result = []
      for (let index = 0; index < itemLimit; index += 1) {
        let item
        try {
          item = value[index]
        } catch {
          item = RENDERER_TELEMETRY_MARKERS.UNAVAILABLE
        }
        result.push(sanitizeValue(item, depth + 1, state))
      }
      if (isTruncated) {
        result.push(RENDERER_TELEMETRY_MARKERS.MAX_ARRAY_LENGTH)
      }
      return result
    }

    let keys
    try {
      keys = Object.keys(value)
    } catch {
      return RENDERER_TELEMETRY_MARKERS.UNAVAILABLE
    }
    const result = {}
    const hasObjectOverflow = keys.length > RENDERER_TELEMETRY_LIMITS.MAX_OBJECT_KEYS
    const objectKeyLimit = hasObjectOverflow
      ? RENDERER_TELEMETRY_LIMITS.MAX_OBJECT_KEYS - 1
      : keys.length
    let didTruncate = hasObjectOverflow

    for (let index = 0; index < objectKeyLimit; index += 1) {
      if (state.remainingKeys <= 0) {
        didTruncate = true
        break
      }
      const key = keys[index]
      if (key === TRUNCATION_KEY) {
        continue
      }
      state.remainingKeys -= 1
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        defineSafeValue(result, key, RENDERER_TELEMETRY_MARKERS.REDACTED)
        continue
      }
      let child
      try {
        child = value[key]
      } catch {
        child = RENDERER_TELEMETRY_MARKERS.UNAVAILABLE
      }
      defineSafeValue(result, key, sanitizeValue(child, depth + 1, state))
    }

    if (didTruncate) {
      defineSafeValue(result, TRUNCATION_KEY, RENDERER_TELEMETRY_MARKERS.MAX_KEYS)
    }
    return result
  } finally {
    state.seen.delete(value)
  }
}

function sanitizeRendererTelemetryPayload(payload) {
  return sanitizeValue(payload, 0, {
    remainingKeys: RENDERER_TELEMETRY_LIMITS.MAX_TOTAL_KEYS,
    seen: new WeakSet(),
  })
}

function normalizeTrustedTimestamp(now) {
  try {
    const timestamp = now instanceof Date ? now : new Date(now)
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
  } catch {
    return null
  }
}

function createRendererTelemetryRecord({ role, event, payload, now = new Date() } = {}) {
  if (!isAllowedRendererRole(role)) {
    return { ok: false, reason: 'forbidden' }
  }
  if (
    typeof event !== 'string'
    || !event.trim()
    || event.length > RENDERER_TELEMETRY_LIMITS.MAX_EVENT_LENGTH
  ) {
    return { ok: false, reason: 'invalid-event' }
  }
  const ts = normalizeTrustedTimestamp(now)
  if (!ts) {
    return { ok: false, reason: 'invalid-time' }
  }
  const sanitizedPayload = sanitizeRendererTelemetryPayload(payload)
  return {
    ok: true,
    record: {
      payload: sanitizedPayload,
      event,
      ts,
      role,
    },
  }
}

function createRendererHeartbeatRecord({ role, payload, now = new Date() } = {}) {
  const result = createRendererTelemetryRecord({
    role,
    event: RENDERER_HEARTBEAT_EVENT,
    payload,
    now,
  })
  if (!result.ok) {
    return result
  }
  return {
    ok: true,
    key: role,
    heartbeat: result.record,
  }
}

module.exports = {
  RENDERER_HEARTBEAT_EVENT,
  RENDERER_TELEMETRY_LIMITS,
  RENDERER_TELEMETRY_MARKERS,
  RENDERER_TELEMETRY_ROLES,
  createRendererHeartbeatRecord,
  createRendererTelemetryRecord,
  isAllowedRendererRole,
  sanitizeRendererTelemetryPayload,
}
