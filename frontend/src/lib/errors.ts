function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined
  return typeof error.response.status === 'number' ? error.response.status : undefined
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (isRecord(error) && isRecord(error.response) && isRecord(error.response.data)) {
    const detail = error.response.data.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    // FastAPI returns validation errors as a list, which React cannot render directly.
    if (Array.isArray(detail)) {
      const messages = detail.flatMap((item: unknown) =>
        isRecord(item) && typeof item.msg === 'string' && item.msg.trim() ? [item.msg] : [],
      )
      if (messages.length) return [...new Set(messages)].join('；')
    }
  }

  if (isRecord(error) && isRecord(error.response) && error.response.status === 429) {
    const headers = error.response.headers
    const retryAfter = isRecord(headers) ? headers['retry-after'] ?? headers['Retry-After'] : undefined
    const seconds = typeof retryAfter === 'string' || typeof retryAfter === 'number' ? Number(retryAfter) : NaN
    return Number.isInteger(seconds) && seconds > 0 && seconds <= 3600
      ? `操作太频繁，请在 ${seconds} 秒后重试。`
      : '操作太频繁，请稍等片刻再试。'
  }

  if (isRecord(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return '请求超时，请稍后重试。'
    if (error.code === 'ERR_NETWORK') return '网络连接暂时不可用，请检查网络后重试。'
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}
