import {
  assertApiOperationContextCurrent,
  clearSessionToken,
  desktopApiRequest,
  getApiBaseUrl,
  getSessionSnapshot,
} from './api'
import { createAuthContextChangedError, isAuthContextChangedError } from './pet-account-context'
import { formatApiErrorDetail } from './api-error'
import { runWithRequestDeadline } from './request-deadline'
import { createVoiceAuthError } from './voice-errors'

// These capabilities only stop a session returned by this module's own create
// request. They never authorize another operation or consult a new login/server.
const ownedSessionStops = new WeakMap()
const STOP_TIMEOUT_MS = 5_000

function requireVoiceContext(operationContext) {
  if (!operationContext?.authoritative || !operationContext?.session?.token) {
    throw createAuthContextChangedError()
  }
}

async function assertVoiceContextCurrent(operationContext, apiBaseUrl) {
  await assertApiOperationContextCurrent(operationContext)
  if (await getApiBaseUrl() !== apiBaseUrl) throw createAuthContextChangedError()
  await assertApiOperationContextCurrent(operationContext)
}

async function readVoiceResponse(response) {
  if (response.status === 204) return null
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: '请求失败' }))
    const error = new Error(formatApiErrorDetail(payload.detail))
    error.status = response.status
    throw error
  }
  return response.json()
}

function ownSessionStop(operationContext, apiBaseUrl, token, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId === '.' || sessionId === '..') return null
  const url = `${apiBaseUrl}/rtc/voice-demo/session/${encodeURIComponent(sessionId)}/stop`
  let capturedToken = token
  let pending = null
  let stopped = false
  let stoppedResponse
  const stop = () => {
    if (stopped) return Promise.resolve(stoppedResponse)
    if (pending) return pending
    pending = runWithRequestDeadline(async (signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capturedToken}` },
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
      const payload = await readVoiceResponse(response)
      signal.throwIfAborted()
      stopped = true
      stoppedResponse = payload
      capturedToken = null
      return payload
    }, { timeoutMs: STOP_TIMEOUT_MS }).finally(() => { pending = null })
    return pending
  }
  let sessions = ownedSessionStops.get(operationContext)
  if (!sessions) {
    sessions = new Map()
    ownedSessionStops.set(operationContext, sessions)
  }
  sessions.set(sessionId, stop)
  return stop
}

async function requestVoice(path, options = {}, operationContext = null) {
  requireVoiceContext(operationContext)
  try {
    return await desktopApiRequest(path, options, operationContext)
  } catch (error) {
    if (isAuthContextChangedError(error)) throw error
    const currentSession = await getSessionSnapshot().catch(() => null)
    if (
      !currentSession?.token
      || error?.status === 401
      || error?.message === '登录已过期，请重新登录。'
    ) {
      throw createVoiceAuthError()
    }
    throw error
  }
}

export async function createVoiceDemoSession(payload = {}, operationContext = null) {
  requireVoiceContext(operationContext)
  await assertApiOperationContextCurrent(operationContext)
  const apiBaseUrl = await getApiBaseUrl()
  if (!apiBaseUrl) throw new Error('请先配置服务地址，再使用桌面客户端。')
  await assertVoiceContextCurrent(operationContext, apiBaseUrl)
  const token = operationContext.session.token
  return runWithRequestDeadline(async (signal) => {
    let stopCreatedSession = null
    try {
      const response = await fetch(`${apiBaseUrl}/rtc/voice-demo/session`, {
        method: 'POST',
        body: JSON.stringify(payload || {}),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
      // Read and retain ownership before checking account freshness. Otherwise a
      // successful late create loses its sessionId and can no longer be stopped.
      const created = await readVoiceResponse(response)
      stopCreatedSession = ownSessionStop(operationContext, apiBaseUrl, token, created?.sessionId)
      signal.throwIfAborted()
      await assertVoiceContextCurrent(operationContext, apiBaseUrl)
      signal.throwIfAborted()
      return created
    } catch (error) {
      if (stopCreatedSession) void stopCreatedSession().catch(() => undefined)
      if (signal.aborted) throw signal.reason
      await assertVoiceContextCurrent(operationContext, apiBaseUrl)
      signal.throwIfAborted()
      if (error?.status === 401) {
        // The expected snapshot prevents a racing logout/login from clearing B.
        await clearSessionToken(operationContext.session).catch(() => undefined)
        throw createVoiceAuthError()
      }
      throw error
    }
  })
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
  const ownedStop = operationContext && ownedSessionStops.get(operationContext)?.get(sessionId)
  if (ownedStop) return ownedStop()
  return requestVoice(
    `/rtc/voice-demo/session/${sessionId}/stop`,
    { method: 'POST' },
    operationContext,
  )
}
