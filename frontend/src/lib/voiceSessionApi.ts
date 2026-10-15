import type {
  VoiceDemoSessionActionResponse,
  VoiceDemoSessionCreateResponse,
  VoiceDemoSessionStatusResponse,
  VoiceDemoStopResponse,
} from '../types/index.js'
import { VoiceConnectionCancelledError } from './voiceSessionController.js'

export interface OwnedVoiceDemoSession {
  session: VoiceDemoSessionCreateResponse
  start: () => Promise<VoiceDemoSessionActionResponse>
  getStatus: () => Promise<VoiceDemoSessionStatusResponse>
  interrupt: () => Promise<VoiceDemoSessionActionResponse>
  stop: () => Promise<VoiceDemoStopResponse>
}

interface VoiceSessionApiOptions {
  baseUrl: string
  token: string
  isCurrent: () => boolean
  fetcher?: typeof fetch
  onUnauthorized?: () => void
  timeoutMs?: number
  stopTimeoutMs?: number
}

export function createVoiceSessionApi({
  baseUrl,
  token,
  isCurrent,
  fetcher = fetch,
  onUnauthorized,
  timeoutMs = 30_000,
  stopTimeoutMs = 5_000,
}: VoiceSessionApiOptions) {
  const base = baseUrl.replace(/\/+$/, '')
  const assertCurrent = () => {
    if (!token || !isCurrent()) throw new VoiceConnectionCancelledError()
  }

  async function request<T>(url: string, {
    method = 'POST', cleanup = false, onSuccess,
  }: { method?: string; cleanup?: boolean; onSuccess?: (data: T) => void } = {}): Promise<T> {
    if (!cleanup) assertCurrent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cleanup ? stopTimeoutMs : timeoutMs)
    try {
      const response = await fetcher(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        keepalive: cleanup,
        redirect: 'error',
        cache: 'no-store',
      })
      const data = await response.json()
      if (response.ok) onSuccess?.(data as T)
      if (controller.signal.aborted) throw new Error('语音请求超时，请重试。')
      if (!response.ok) {
        if (!cleanup && response.status === 401 && isCurrent()) onUnauthorized?.()
        const error = new Error(typeof data?.detail === 'string' ? data.detail : '语音会话请求失败。')
        Object.assign(error, { status: response.status })
        throw error
      }
      return data as T
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async create(): Promise<OwnedVoiceDemoSession> {
      let receivedId: string | undefined
      let session: VoiceDemoSessionCreateResponse
      try {
        session = await request<VoiceDemoSessionCreateResponse>(`${base}/rtc/voice-demo/session`, {
          onSuccess: (data) => { receivedId = data?.sessionId },
        })
      } catch (error) {
        // A response body can complete at the deadline. Retain its session ID
        // before the timeout check so that this known late session is stopped.
        if (typeof receivedId === 'string' && receivedId && receivedId !== '.' && receivedId !== '..') {
          await request(`${base}/rtc/voice-demo/session/${encodeURIComponent(receivedId)}/stop`, { cleanup: true })
            .catch(() => undefined)
        }
        throw error
      }
      const sessionId = session?.sessionId
      if (typeof sessionId !== 'string' || !sessionId || sessionId === '.' || sessionId === '..') {
        throw new Error('后端未返回有效的语音会话。')
      }
      const sessionUrl = `${base}/rtc/voice-demo/session/${encodeURIComponent(sessionId)}`
      let stopPending: Promise<VoiceDemoStopResponse> | null = null
      let stopResponse: VoiceDemoStopResponse | null = null
      const owned: OwnedVoiceDemoSession = {
        session,
        async start() {
          const response = await request<VoiceDemoSessionActionResponse>(`${sessionUrl}/start`)
          assertCurrent()
          return response
        },
        async getStatus() {
          const response = await request<VoiceDemoSessionStatusResponse>(sessionUrl, { method: 'GET' })
          assertCurrent()
          return response
        },
        async interrupt() {
          const response = await request<VoiceDemoSessionActionResponse>(`${sessionUrl}/interrupt`)
          assertCurrent()
          return response
        },
        stop() {
          if (stopResponse) return Promise.resolve(stopResponse)
          if (stopPending) return stopPending
          // Only this create response grants a stop closure. It retains its own
          // token, URL and ID across logout and never authorizes another action.
          stopPending = request<VoiceDemoStopResponse>(`${sessionUrl}/stop`, { cleanup: true })
            .then((response) => { stopResponse = response; return response })
            .finally(() => { stopPending = null })
          return stopPending
        },
      }
      if (!isCurrent()) {
        await owned.stop().catch(() => undefined)
        throw new VoiceConnectionCancelledError()
      }
      return owned
    },
  }
}
