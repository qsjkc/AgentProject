import { desktopApiRequest, getSessionSnapshot } from './api'
import { createAuthContextChangedError } from './pet-account-context'
import { createVoiceAuthError } from './voice-errors'

async function requestVoice(path, options = {}, operationContext = null) {
  if (!operationContext?.authoritative || !operationContext?.session?.token) {
    throw createAuthContextChangedError()
  }
  try {
    return await desktopApiRequest(path, options, operationContext)
  } catch (error) {
    const currentSession = await getSessionSnapshot().catch(() => null)
    if (
      !currentSession?.token
      || error?.status === 401
      || error?.status === 403
      || error?.message === '登录已过期，请重新登录。'
    ) {
      throw createVoiceAuthError()
    }
    throw error
  }
}

export function createVoiceDemoSession(payload = {}, operationContext = null) {
  return requestVoice('/rtc/voice-demo/session', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }, operationContext)
}

export function startVoiceDemoSession(sessionId, operationContext = null) {
  return requestVoice(
    `/rtc/voice-demo/session/${sessionId}/start`,
    { method: 'POST' },
    operationContext,
  )
}

export function getVoiceDemoSession(sessionId, operationContext = null) {
  return requestVoice(`/rtc/voice-demo/session/${sessionId}`, {}, operationContext)
}

export function interruptVoiceDemoSession(sessionId, operationContext = null) {
  return requestVoice(
    `/rtc/voice-demo/session/${sessionId}/interrupt`,
    { method: 'POST' },
    operationContext,
  )
}

export function stopVoiceDemoSession(sessionId, operationContext = null) {
  return requestVoice(
    `/rtc/voice-demo/session/${sessionId}/stop`,
    { method: 'POST' },
    operationContext,
  )
}
