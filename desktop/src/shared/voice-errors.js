export const VOICE_AUTH_ERROR_CODE = 'VOICE_AUTH_EXPIRED'

const AUTH_ERROR_RE = /could not validate credentials|not authenticated|invalid token|unauthorized|\b401\b|登录已过期|请先登录/i

export function createVoiceAuthError(message = '登录已过期，请在主面板重新登录。') {
  const error = new Error(message)
  error.code = VOICE_AUTH_ERROR_CODE
  return error
}

export function isVoiceAuthError(error) {
  if (!error) {
    return false
  }
  if (error.status === 403) return false
  if (error.status === 401) return true
  if (error.code === VOICE_AUTH_ERROR_CODE) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return AUTH_ERROR_RE.test(message)
}
