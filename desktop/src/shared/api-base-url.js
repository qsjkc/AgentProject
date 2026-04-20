export function normalizeApiBaseUrl(value) {
  const rawValue = String(value || '').trim()
  if (!rawValue) {
    return ''
  }

  let normalizedValue = rawValue.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(normalizedValue)) {
    normalizedValue = `http://${normalizedValue}`
  }

  if (!/\/api\/v\d+$/i.test(normalizedValue)) {
    if (/\/api$/i.test(normalizedValue)) {
      normalizedValue = `${normalizedValue}/v1`
    } else {
      normalizedValue = `${normalizedValue}/api/v1`
    }
  }

  return normalizedValue
}
