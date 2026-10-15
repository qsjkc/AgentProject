export function formatApiErrorDetail(detail, fallback = '请求失败') {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => formatApiErrorDetail(item, '')).filter(Boolean)
    return messages.length ? messages.join('；') : fallback
  }
  if (detail && typeof detail === 'object') {
    return formatApiErrorDetail(detail.msg ?? detail.message, fallback)
  }
  return fallback
}
