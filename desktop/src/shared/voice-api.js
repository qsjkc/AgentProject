import { clearSessionToken, getApiBaseUrl, getSessionToken } from './api'
import { createVoiceAuthError } from './voice-errors'

async function parseErrorPayload(response, fallbackDetail = '语音请求失败。') {
  try {
    const payload = await response.json()
    if (payload && typeof payload === 'object') {
      const detail = payload.detail ?? payload.message ?? fallbackDetail
      return {
        ...payload,
        detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      }
    }
  } catch {
    // fall through to fallback detail
  }

  return { detail: fallbackDetail }
}

async function requestVoice(path, options = {}) {
  const apiBaseUrl = await getApiBaseUrl()
  if (!apiBaseUrl) {
    throw new Error('请先在主面板配置服务地址。')
  }

  const token = await getSessionToken()
  if (!token) {
    throw createVoiceAuthError()
  }

  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = await parseErrorPayload(response)
    if (response.status === 401 || response.status === 403) {
      await clearSessionToken().catch(() => undefined)
      throw createVoiceAuthError()
    }
    throw new Error(payload.detail || '语音请求失败。')
  }

  return response.json()
}

export function createVoiceDemoSession() {
  return requestVoice('/rtc/voice-demo/session', { method: 'POST' })
}

export function startVoiceDemoSession(sessionId) {
  return requestVoice(`/rtc/voice-demo/session/${sessionId}/start`, { method: 'POST' })
}

export function getVoiceDemoSession(sessionId) {
  return requestVoice(`/rtc/voice-demo/session/${sessionId}`)
}

export function interruptVoiceDemoSession(sessionId) {
  return requestVoice(`/rtc/voice-demo/session/${sessionId}/interrupt`, { method: 'POST' })
}

export function stopVoiceDemoSession(sessionId) {
  return requestVoice(`/rtc/voice-demo/session/${sessionId}/stop`, { method: 'POST' })
}
