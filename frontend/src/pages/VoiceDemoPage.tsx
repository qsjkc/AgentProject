import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getErrorMessage } from '../lib/errors'
import { createVoiceRtcSession, isRtcSupported, type VoiceRtcSessionHandle } from '../lib/voiceRtc'
import { apiBaseUrl, apiOrigin } from '../services/api'
import {
  createVoiceDemoSession,
  getVoiceDemoSession,
  interruptVoiceDemoSession,
  startVoiceDemoSession,
  stopVoiceDemoSession,
} from '../services/voiceDemo'
import type {
  VoiceDemoSessionCreateResponse,
  VoiceDemoSessionStatusResponse,
  VoiceDemoState,
  VoiceDemoUiPhase,
} from '../types'

type PermissionStateLabel = PermissionState | 'unknown' | 'unsupported'

interface EventLogEntry {
  id: number
  message: string
  level: 'info' | 'error'
  at: string
}

const secureLocalHosts = new Set(['localhost', '127.0.0.1'])

function buildApiUrl(path: string) {
  const sanitizedBase = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
  return new URL(path.replace(/^\//, ''), sanitizedBase.startsWith('http') ? sanitizedBase : `${apiOrigin}${sanitizedBase}`).toString()
}

async function queryMicrophonePermission(): Promise<PermissionStateLabel> {
  if (!('permissions' in navigator) || !navigator.permissions?.query) {
    return 'unsupported'
  }
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return 'unsupported'
  }
}

async function ensureMicrophoneAccess() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风采集。')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  stream.getTracks().forEach((track) => track.stop())
}

function isSecureVoiceContext() {
  return window.isSecureContext || secureLocalHosts.has(window.location.hostname)
}

function voiceStateLabel(state: VoiceDemoState | null) {
  const labels: Record<VoiceDemoState, string> = {
    creating: '创建中',
    active: '进行中',
    stopping: '停止中',
    stopped: '已停止',
    expired: '已过期',
    stop_pending: '待清理',
    cleanup_failed: '清理失败',
    failed: '启动失败',
  }
  return state ? labels[state] : '未知'
}

function phaseLabel(phase: VoiceDemoUiPhase) {
  const labels: Record<VoiceDemoUiPhase, string> = {
    idle: '空闲',
    creating_session: '创建 session 中',
    joining_room: '加入房间中',
    connected: '已连接',
    interrupting: '打断中',
    stopping: '停止中',
    stopped: '已停止',
    error: '错误',
  }
  return labels[phase]
}

function permissionLabel(permission: PermissionStateLabel) {
  const labels: Record<PermissionStateLabel, string> = {
    granted: '已授权',
    denied: '已拒绝',
    prompt: '待授权',
    unknown: '未知',
    unsupported: '浏览器不支持查询',
  }
  return labels[permission]
}

function keepAliveStop(sessionId: string) {
  const token = localStorage.getItem('token')
  if (!token) {
    return
  }
  void fetch(buildApiUrl(`rtc/voice-demo/session/${sessionId}/stop`), {
    method: 'POST',
    keepalive: true,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }).catch(() => undefined)
}

export default function VoiceDemoPage() {
  const [phase, setPhase] = useState<VoiceDemoUiPhase>('idle')
  const [backendSession, setBackendSession] = useState<VoiceDemoSessionCreateResponse | null>(null)
  const [backendStatus, setBackendStatus] = useState<VoiceDemoSessionStatusResponse | null>(null)
  const [backendState, setBackendState] = useState<VoiceDemoState | null>(null)
  const [rtcRoomState, setRtcRoomState] = useState('idle')
  const [rtcConnectionState, setRtcConnectionState] = useState('idle')
  const [micPermission, setMicPermission] = useState<PermissionStateLabel>('unknown')
  const [muted, setMuted] = useState(false)
  const [aiSpeaking, setAiSpeaking] = useState(false)
  const [inputSuppressed, setInputSuppressed] = useState(false)
  const [feedbackProtectionEnabled, setFeedbackProtectionEnabled] = useState(true)
  const [remoteAudioAttached, setRemoteAudioAttached] = useState(false)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<EventLogEntry[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rtcSessionRef = useRef<VoiceRtcSessionHandle | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const logIdRef = useRef(0)

  const pushLog = useCallback((message: string, level: 'info' | 'error' = 'info') => {
    logIdRef.current += 1
    setLogs((current) => [
      {
        id: logIdRef.current,
        message,
        level,
        at: new Date().toLocaleTimeString(),
      },
      ...current,
    ].slice(0, 30))
  }, [])

  const setRemoteTrack = useCallback((track: MediaStreamTrack | null) => {
    const audioElement = audioRef.current
    if (!audioElement) {
      return
    }

    if (!track) {
      audioElement.srcObject = null
      setRemoteAudioAttached(false)
      return
    }

    const stream = new MediaStream([track])
    audioElement.srcObject = stream
    void audioElement.play().catch(() => {
      pushLog('远端音频已附加，但浏览器阻止了自动播放。请点击“重连”后再试。', 'error')
    })
    setRemoteAudioAttached(true)
  }, [pushLog])

  const refreshMicPermission = useCallback(async () => {
    const permission = await queryMicrophonePermission()
    setMicPermission(permission)
  }, [])

  const refreshBackendStatus = useCallback(async (sessionId: string) => {
    try {
      const status = await getVoiceDemoSession(sessionId)
      setBackendStatus(status)
      setBackendState(status.state)
    } catch (err) {
      pushLog(getErrorMessage(err, '刷新后端 session 状态失败。'), 'error')
    }
  }, [pushLog])

  const cleanupRtc = useCallback(
    async ({ stopBackend }: { stopBackend: boolean }) => {
      const currentSessionId = sessionIdRef.current
      const rtcSession = rtcSessionRef.current

      try {
        if (rtcSession) {
          await rtcSession.leave()
          rtcSession.destroy()
        }
      } catch (err) {
        pushLog(getErrorMessage(err, 'RTC 清理失败。'), 'error')
      } finally {
        rtcSessionRef.current = null
        setMuted(false)
        setAiSpeaking(false)
        setInputSuppressed(false)
        setRtcRoomState('left')
        setRtcConnectionState('idle')
        setRemoteTrack(null)
      }

      if (stopBackend && currentSessionId) {
        try {
          const response = await stopVoiceDemoSession(currentSessionId)
          setBackendState(response.state)
          pushLog(response.cleanupPending ? '挂断请求已接收，后端将继续清理会话。' : '挂断完成。')
        } catch (err) {
          pushLog(getErrorMessage(err, '后端 stop 请求失败。'), 'error')
        }
      }
    },
    [pushLog, setRemoteTrack],
  )

  const resetSessionState = useCallback(() => {
    sessionIdRef.current = null
    setBackendSession(null)
    setBackendStatus(null)
    setBackendState(null)
  }, [])

  useEffect(() => {
    void refreshMicPermission()
  }, [refreshMicPermission])

  useEffect(() => {
    if (!sessionIdRef.current || phase !== 'connected') {
      return undefined
    }

    const timer = window.setInterval(() => {
      if (sessionIdRef.current) {
        void refreshBackendStatus(sessionIdRef.current)
      }
    }, 15000)

    return () => window.clearInterval(timer)
  }, [phase, refreshBackendStatus])

  useEffect(() => {
    const handleBeforeUnload = () => {
      const currentSessionId = sessionIdRef.current
      if (currentSessionId) {
        keepAliveStop(currentSessionId)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      const currentSessionId = sessionIdRef.current
      if (currentSessionId) {
        keepAliveStop(currentSessionId)
      }
      void cleanupRtc({ stopBackend: false })
    }
  }, [cleanupRtc])

  const handleConnect = useCallback(async () => {
    if (phase === 'creating_session' || phase === 'joining_room' || phase === 'interrupting' || phase === 'stopping') {
      return
    }

    if (!isSecureVoiceContext()) {
      const message = '语音 Demo 只允许在 HTTPS 或 localhost / 127.0.0.1 环境中连接。'
      setError(message)
      pushLog(message, 'error')
      return
    }

    setError('')
    setPhase('creating_session')
    pushLog('开始准备语音会话。')

    let createdSession: VoiceDemoSessionCreateResponse | null = null
    let rtcSession: VoiceRtcSessionHandle | null = null

    try {
      if (!(await isRtcSupported())) {
        throw new Error('当前浏览器不支持火山 RTC Web SDK。')
      }

      await refreshMicPermission()
      await ensureMicrophoneAccess()
      setMicPermission('granted')
      pushLog('麦克风权限检查通过。')

      createdSession = await createVoiceDemoSession()
      sessionIdRef.current = createdSession.sessionId
      setBackendSession(createdSession)
      setBackendState(createdSession.state)
      pushLog(`后端 session 已创建：${createdSession.sessionId}`)

      setPhase('joining_room')
      rtcSession = await createVoiceRtcSession({
        appId: createdSession.appId,
        roomId: createdSession.roomId,
        userId: createdSession.userId,
        aiUserId: createdSession.aiUserId,
        token: createdSession.token,
        feedbackProtectionEnabled,
        onConnectionStateChange: (state) => setRtcConnectionState(state),
        onRoomStateChange: (state) => setRtcRoomState(state),
        onRemoteAudioTrack: setRemoteTrack,
        onAiSpeakingChange: setAiSpeaking,
        onInputSuppressionChange: setInputSuppressed,
        onLog: (message) => pushLog(message),
        onError: (message) => {
          setError(message)
          pushLog(message, 'error')
        },
      })
      rtcSessionRef.current = rtcSession

      await rtcSession.joinAndPublish()

      const startResponse = await startVoiceDemoSession(createdSession.sessionId)
      setBackendState(startResponse.state)
      pushLog(startResponse.started ? '后端 VoiceChat 已启动。' : '后端 session 已处于启动状态。')

      await refreshBackendStatus(createdSession.sessionId)
      setMuted(false)
      setPhase('connected')
    } catch (err) {
      const message = getErrorMessage(err, '连接语音 Demo 失败。')
      setError(message)
      pushLog(message, 'error')
      setPhase('error')

      if (rtcSession) {
        try {
          await rtcSession.leave()
        } catch (leaveError) {
          pushLog(getErrorMessage(leaveError, '连接失败后清理 RTC 房间失败。'), 'error')
        }
        rtcSession.destroy()
      }
      rtcSessionRef.current = null

      if (createdSession?.sessionId) {
        try {
          await stopVoiceDemoSession(createdSession.sessionId)
        } catch (stopError) {
          pushLog(getErrorMessage(stopError, '连接失败后的 stop 请求失败。'), 'error')
        }
      }
      resetSessionState()
    }
  }, [feedbackProtectionEnabled, phase, pushLog, refreshBackendStatus, refreshMicPermission, resetSessionState, setRemoteTrack])

  const handleMuteToggle = useCallback(async () => {
    const rtcSession = rtcSessionRef.current
    if (!rtcSession || phase !== 'connected') {
      return
    }

    setError('')
    try {
      if (muted) {
        await rtcSession.unmute()
        setMuted(false)
      } else {
        await rtcSession.mute()
        setMuted(true)
      }
    } catch (err) {
      const message = getErrorMessage(err, '切换静音失败。')
      setError(message)
      pushLog(message, 'error')
    }
  }, [muted, phase, pushLog])

  const handleInterrupt = useCallback(async () => {
    const currentSessionId = sessionIdRef.current
    if (!currentSessionId) {
      return
    }

    setPhase('interrupting')
    try {
      const response = await interruptVoiceDemoSession(currentSessionId)
      setBackendState(response.state)
      pushLog(response.accepted ? '已发送打断指令。' : response.lastError || '当前 session 已不再接收打断指令。')
      setPhase(rtcSessionRef.current?.isJoined() ? 'connected' : 'stopped')
    } catch (err) {
      const message = getErrorMessage(err, '发送打断失败。')
      setError(message)
      pushLog(message, 'error')
      setPhase('error')
    }
  }, [pushLog])

  const handleHangup = useCallback(async () => {
    setPhase('stopping')
    await cleanupRtc({ stopBackend: true })
    resetSessionState()
    setPhase('stopped')
  }, [cleanupRtc, resetSessionState])

  const handleReconnect = useCallback(async () => {
    await cleanupRtc({ stopBackend: true })
    resetSessionState()
    setPhase('stopped')
    await handleConnect()
  }, [cleanupRtc, handleConnect, resetSessionState])

  const handleFeedbackProtectionToggle = useCallback(() => {
    const next = !feedbackProtectionEnabled
    setFeedbackProtectionEnabled(next)
    rtcSessionRef.current?.setFeedbackProtectionEnabled(next)
    pushLog(next ? '已开启扬声器回灌防护。' : '已关闭扬声器回灌防护。')
  }, [feedbackProtectionEnabled, pushLog])

  const statusItems = useMemo(
    () => [
      { label: '页面状态', value: phaseLabel(phase) },
      { label: '后端 session state', value: voiceStateLabel(backendState) },
      { label: 'RTC room state', value: rtcRoomState },
      { label: 'RTC connection state', value: rtcConnectionState },
      { label: '麦克风权限', value: permissionLabel(micPermission) },
      { label: 'AI 说话中', value: aiSpeaking ? '是' : '否' },
      { label: '输入抑制', value: inputSuppressed ? '抑制中' : '空闲' },
      { label: 'AI 音频订阅', value: remoteAudioAttached ? '已附加' : '等待中' },
    ],
    [aiSpeaking, backendState, inputSuppressed, micPermission, phase, remoteAudioAttached, rtcConnectionState, rtcRoomState],
  )

  return (
    <div className="space-y-8">
      <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Voice Demo</div>
        <h1 className="mt-4 text-4xl font-semibold text-slate-950">AI 语音 Demo</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
          这个页面用于联调火山引擎 RTC 语音 Agent Demo。点击“连接”后，页面会先创建后端 session，再加入 RTC 房间、发布本地麦克风，只订阅 AI 用户的远端音频。
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={phase === 'creating_session' || phase === 'joining_room' || phase === 'interrupting' || phase === 'stopping' || phase === 'connected'}
            className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            连接
          </button>
          <button
            type="button"
            onClick={() => void handleMuteToggle()}
            disabled={phase !== 'connected'}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-900 transition hover:border-slate-950 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {muted ? '取消静音' : '静音'}
          </button>
          <button
            type="button"
            onClick={() => void handleInterrupt()}
            disabled={!sessionIdRef.current || !['connected', 'interrupting'].includes(phase)}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-900 transition hover:border-slate-950 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            打断 AI
          </button>
          <button
            type="button"
            onClick={() => void handleHangup()}
            disabled={!sessionIdRef.current && !rtcSessionRef.current}
            className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-3 text-sm font-medium text-rose-700 transition hover:border-rose-400 disabled:cursor-not-allowed disabled:text-rose-300"
          >
            挂断
          </button>
          <button
            type="button"
            onClick={() => void handleReconnect()}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-900 transition hover:border-slate-950"
          >
            重连
          </button>
          <button
            type="button"
            onClick={handleFeedbackProtectionToggle}
            className={`rounded-2xl border px-5 py-3 text-sm font-medium transition ${
              feedbackProtectionEnabled
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400'
                : 'border-slate-200 bg-white text-slate-900 hover:border-slate-950'
            }`}
          >
            回灌防护 {feedbackProtectionEnabled ? '开' : '关'}
          </button>
        </div>

        {error && <div className="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {inputSuppressed && (
          <div className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
            AI 正在说话，页面已临时抑制本地麦克风输入，避免扬声器回采导致 AI 听到自己的声音。需要强制打断时，直接点击“打断 AI”。
          </div>
        )}
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-8">
          <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Status</div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {statusItems.map((item) => (
                <div key={item.label} className="rounded-[1.5rem] bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.label}</div>
                  <div className="mt-3 break-all text-sm font-medium text-slate-900">{item.value}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Session</div>
            <div className="mt-6 space-y-3 text-sm text-slate-700">
              <div><span className="font-medium text-slate-900">sessionId:</span> {backendSession?.sessionId ?? '-'}</div>
              <div><span className="font-medium text-slate-900">roomId:</span> {backendSession?.roomId ?? '-'}</div>
              <div><span className="font-medium text-slate-900">userId:</span> {backendSession?.userId ?? '-'}</div>
              <div><span className="font-medium text-slate-900">aiUserId:</span> {backendSession?.aiUserId ?? '-'}</div>
              <div>
                <span className="font-medium text-slate-900">expiresAt:</span>{' '}
                {backendSession?.expiresAt ? new Date(backendSession.expiresAt).toLocaleString() : '-'}
              </div>
              <div><span className="font-medium text-slate-900">lastAction:</span> {backendStatus?.lastAction ?? '-'}</div>
              <div><span className="font-medium text-slate-900">lastError:</span> {backendStatus?.lastError ?? '-'}</div>
            </div>
          </article>
        </div>

        <div className="space-y-8">
          <article className="rounded-[2rem] border border-slate-200 bg-slate-950 p-8 text-white">
            <div className="text-xs uppercase tracking-[0.3em] text-slate-400">Remote Audio</div>
            <div className="mt-4 text-2xl font-semibold">AI 远端音频</div>
            <p className="mt-3 text-sm leading-7 text-slate-300">
              页面不会在进入时主动发起语音会话。只有点击“连接”后才会建立 RTC 会话并播放 AI 回复。若浏览器限制自动播放，请重新点击“连接”或“重连”后再试。
            </p>
            <div className="mt-6 text-sm text-slate-300">
              当前状态：{remoteAudioAttached ? '已附加远端音轨' : '等待 AI 发布音频'}
            </div>
            <audio ref={audioRef} autoPlay playsInline className="mt-4 w-full" controls />
          </article>

          <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Events</div>
            <div className="mt-6 max-h-[28rem] space-y-3 overflow-y-auto">
              {logs.length === 0 ? (
                <div className="rounded-[1.5rem] bg-slate-50 p-4 text-sm text-slate-500">暂无事件日志。</div>
              ) : (
                logs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-[1.5rem] p-4 text-sm ${
                      entry.level === 'error'
                        ? 'bg-rose-50 text-rose-700'
                        : 'bg-slate-50 text-slate-700'
                    }`}
                  >
                    <div className="text-xs uppercase tracking-[0.2em] opacity-60">{entry.at}</div>
                    <div className="mt-2 leading-6">{entry.message}</div>
                  </div>
                ))
              )}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
