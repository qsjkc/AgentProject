import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import { createVoiceSessionApi } from '../lib/voiceSessionApi'
import { apiBaseUrl, apiOrigin } from './api'

export function captureVoiceDemoApi(token: string, isCurrent: () => boolean) {
  const baseUrl = new URL(apiBaseUrl, apiOrigin).toString()
  return createVoiceSessionApi({
    baseUrl,
    token,
    isCurrent: () => isCurrent() && localStorage.getItem('token') === token,
    onUnauthorized: () => {
      if (localStorage.getItem('token') !== token) return
      localStorage.removeItem('token')
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    },
  })
}
