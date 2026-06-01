function sanitizeValue(value) {
  if (value == null) {
    return value
  }

  if (typeof value === 'string') {
    if (value.length > 160) {
      return `${value.slice(0, 160)}...`
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(item))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, itemValue]) => [key, sanitizeValue(itemValue)]),
    )
  }

  return value
}

export function summarizeSubtitlePayload(items) {
  return items.map((item) => ({
    speakerId: item.speakerId,
    isFinal: item.isFinal,
    sequence: item.sequence,
    textLength: item.text.length,
    textPreview: item.text.slice(0, 48),
  }))
}

export function createVoiceDebugLogger(logFn) {
  return {
    event(event, details = {}) {
      return logFn({
        event,
        details: sanitizeValue(details),
      })
    },
    error(event, error, details = {}) {
      return logFn({
        event,
        details: sanitizeValue({
          ...details,
          error: error instanceof Error ? error.message : String(error ?? 'unknown_error'),
        }),
      })
    },
  }
}
