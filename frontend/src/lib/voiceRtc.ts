import type {
  ConnectionStateChangeEvent,
  IRTCEngine,
  MediaType,
  RemoteAudioPropertiesInfo,
  onUserJoinedEvent,
  onUserLeaveEvent,
} from '@volcengine/rtc'
import { VoiceConnectionCancelledError } from './voiceSessionController.js'

type RtcSdk = Pick<typeof import('@volcengine/rtc'), 'AudioProfileType' | 'ConnectionState' | 'MediaType' | 'StreamIndex'> & {
  default: Pick<typeof import('@volcengine/rtc').default, 'createEngine' | 'destroyEngine' | 'events' | 'isSupported'>
}
let sdkPromise: Promise<RtcSdk> | null = null

function sdkRecord(value: unknown): Record<string, unknown> {
  return value && (typeof value === 'object' || typeof value === 'function') ? value as Record<string, unknown> : {}
}

function normalizeRtcSdk(value: unknown): RtcSdk {
  const module = sdkRecord(value)
  const defaultModule = sdkRecord(module.default)
  // Vite loads the package's ESM entry; NodeNext sees the CommonJS namespace.
  // Resolve and validate both shapes instead of relying on an import assertion.
  const engine = typeof defaultModule.createEngine === 'function' ? defaultModule : sdkRecord(defaultModule.default)
  const enums = module.MediaType ? module : defaultModule
  if (
    typeof engine.createEngine !== 'function' || typeof engine.destroyEngine !== 'function'
    || typeof engine.isSupported !== 'function' || !engine.events
    || !enums.AudioProfileType || !enums.ConnectionState || !enums.MediaType || !enums.StreamIndex
  ) {
    throw new Error('RTC SDK 加载结果无效，请刷新后重试。')
  }
  return {
    default: engine as RtcSdk['default'],
    AudioProfileType: enums.AudioProfileType as RtcSdk['AudioProfileType'],
    ConnectionState: enums.ConnectionState as RtcSdk['ConnectionState'],
    MediaType: enums.MediaType as RtcSdk['MediaType'],
    StreamIndex: enums.StreamIndex as RtcSdk['StreamIndex'],
  }
}

function loadRtcSdk(): Promise<RtcSdk> {
  if (sdkPromise) return sdkPromise
  const pending = import('@volcengine/rtc').then(normalizeRtcSdk).catch((error) => {
    sdkPromise = null
    throw error
  })
  sdkPromise = pending
  return pending
}

export interface VoiceRtcSessionConfig {
  appId: string
  roomId: string
  userId: string
  aiUserId: string
  token: string
  feedbackProtectionEnabled?: boolean
  isCurrent?: () => boolean
  onConnectionStateChange: (state: string) => void
  onRoomStateChange: (state: string) => void
  onRemoteAudioTrack: (track: MediaStreamTrack | null) => void
  onLog: (message: string) => void
  onError: (message: string) => void
  onAiSpeakingChange?: (speaking: boolean) => void
  onInputSuppressionChange?: (suppressed: boolean) => void
}

export interface VoiceRtcSessionHandle {
  joinAndPublish: () => Promise<void>
  mute: () => Promise<void>
  unmute: () => Promise<void>
  leave: () => Promise<void>
  destroy: () => void
  isJoined: () => boolean
  isMuted: () => boolean
  isAiSpeaking: () => boolean
  isInputSuppressed: () => boolean
  setFeedbackProtectionEnabled: (enabled: boolean) => void
  isFeedbackProtectionEnabled: () => boolean
}

const AI_SPEAKING_THRESHOLD = 35
const AI_QUIET_HOLD_MS = 1200
const ACTIVE_CAPTURE_VOLUME = 100
const MUTED_CAPTURE_VOLUME = 0
const AI_REMOTE_PLAYBACK_VOLUME = 85

async function waitForRemoteAudioTrack(
  engine: IRTCEngine,
  aiUserId: string,
  streamIndex: Parameters<IRTCEngine['getRemoteStreamTrack']>[1],
  onRemoteAudioTrack: (track: MediaStreamTrack | null) => void,
  isCurrent: () => boolean,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isCurrent()) return
    const track = engine.getRemoteStreamTrack(aiUserId, streamIndex, 'audio')
    if (track) {
      onRemoteAudioTrack(track)
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200))
  }
  if (isCurrent()) onRemoteAudioTrack(null)
}

function extractAiLinearVolume(event: RemoteAudioPropertiesInfo[], aiUserId: string) {
  const aiInfo = event.find((item) => item.streamKey.userId === aiUserId)
  return aiInfo?.audioPropertiesInfo.linearVolume ?? 0
}

export async function isRtcSupported() {
  const { default: VERTC } = await loadRtcSdk()
  return VERTC.isSupported()
}

export async function createVoiceRtcSession(config: VoiceRtcSessionConfig, sdkOverride?: RtcSdk): Promise<VoiceRtcSessionHandle> {
  const { default: VERTC, AudioProfileType, ConnectionState, MediaType, StreamIndex } = sdkOverride ?? await loadRtcSdk()
  if (config.isCurrent?.() === false) throw new VoiceConnectionCancelledError()
  const engine = VERTC.createEngine(config.appId)
  const audioFlag = Number(MediaType.AUDIO)
  let joined = false
  let closed = false
  let destroyed = false
  let joining: Promise<void> | null = null
  let leaving: Promise<void> | null = null
  let manuallyMuted = false
  let aiSpeaking = false
  let inputSuppressed = false
  let feedbackProtectionEnabled = config.feedbackProtectionEnabled ?? true
  let quietTimer: number | null = null

  const isCurrent = () => !closed && !destroyed && config.isCurrent?.() !== false
  const assertCurrent = () => {
    if (!isCurrent()) throw new VoiceConnectionCancelledError()
  }

  const clearQuietTimer = () => {
    if (quietTimer !== null) {
      window.clearTimeout(quietTimer)
      quietTimer = null
    }
  }

  const emitAiSpeaking = (next: boolean) => {
    if (aiSpeaking === next) {
      return
    }
    aiSpeaking = next
    config.onAiSpeakingChange?.(next)
    config.onLog(next ? '已检测到 AI 正在说话。' : 'AI 已结束本轮说话。')
  }

  const applyCapturePolicy = () => {
    if (!isCurrent()) return
    const shouldSuppress = joined && feedbackProtectionEnabled && aiSpeaking && !manuallyMuted
    const volume = manuallyMuted || shouldSuppress ? MUTED_CAPTURE_VOLUME : ACTIVE_CAPTURE_VOLUME

    engine.setCaptureVolume(StreamIndex.STREAM_INDEX_MAIN, volume)

    if (inputSuppressed !== shouldSuppress) {
      inputSuppressed = shouldSuppress
      config.onInputSuppressionChange?.(shouldSuppress)
      config.onLog(
        shouldSuppress
          ? '回灌防护已临时抑制麦克风输入。'
          : '回灌防护已恢复麦克风输入。',
      )
    }
  }

  const handleConnectionStateChanged = (event: ConnectionStateChangeEvent) => {
    if (!isCurrent()) return
    const label = ConnectionState[event.state] ?? String(event.state)
    config.onConnectionStateChange(label)
    config.onLog(`RTC 连接状态 -> ${label}`)
  }

  const handleUserJoined = (event: onUserJoinedEvent) => {
    if (!isCurrent()) return
    if (event.userInfo.userId === config.aiUserId) {
      config.onLog('AI 用户已加入房间。')
    }
  }

  const resetAiSpeechState = () => {
    clearQuietTimer()
    emitAiSpeaking(false)
    if (inputSuppressed) {
      applyCapturePolicy()
    }
  }

  const handleUserLeave = (event: onUserLeaveEvent) => {
    if (!isCurrent()) return
    if (event.userInfo.userId === config.aiUserId) {
      config.onRemoteAudioTrack(null)
      resetAiSpeechState()
      config.onLog('AI 用户已离开房间。')
    }
  }

  const handleUserPublishStream = async (event: { userId: string; mediaType: MediaType | number }) => {
    if (!isCurrent() || event.userId !== config.aiUserId || (Number(event.mediaType) & audioFlag) !== audioFlag) {
      return
    }
    try {
      await engine.subscribeStream(event.userId, MediaType.AUDIO)
      if (!isCurrent()) return
      engine.setPlaybackVolume(config.aiUserId, StreamIndex.STREAM_INDEX_MAIN, AI_REMOTE_PLAYBACK_VOLUME)
      config.onLog('已订阅 AI 远端音频。')
      await waitForRemoteAudioTrack(engine, config.aiUserId, StreamIndex.STREAM_INDEX_MAIN, config.onRemoteAudioTrack, isCurrent)
    } catch (error) {
      if (isCurrent()) config.onError(`订阅 AI 音频失败：${String(error)}`)
    }
  }

  const handleUserUnpublishStream = (event: { userId: string }) => {
    if (!isCurrent()) return
    if (event.userId === config.aiUserId) {
      config.onRemoteAudioTrack(null)
      resetAiSpeechState()
      config.onLog('AI 远端音频已取消发布。')
    }
  }

  const handleRemoteAudioPropertiesReport = (event: RemoteAudioPropertiesInfo[]) => {
    if (!isCurrent()) return
    const aiVolume = extractAiLinearVolume(event, config.aiUserId)
    if (aiVolume >= AI_SPEAKING_THRESHOLD) {
      clearQuietTimer()
      emitAiSpeaking(true)
      applyCapturePolicy()
      return
    }

    if (!aiSpeaking || quietTimer !== null) {
      return
    }

    quietTimer = window.setTimeout(() => {
      quietTimer = null
      if (!isCurrent()) return
      emitAiSpeaking(false)
      applyCapturePolicy()
    }, AI_QUIET_HOLD_MS)
  }

  const handleRtcError = (event: { errorCode?: string | number }) => {
    if (!isCurrent()) return
    config.onError(`RTC 错误：${String(event.errorCode ?? 'unknown')}`)
  }

  try {
    engine.on(VERTC.events.onConnectionStateChanged, handleConnectionStateChanged)
    engine.on(VERTC.events.onUserJoined, handleUserJoined)
    engine.on(VERTC.events.onUserLeave, handleUserLeave)
    engine.on(VERTC.events.onUserPublishStream, handleUserPublishStream)
    engine.on(VERTC.events.onUserUnpublishStream, handleUserUnpublishStream)
    engine.on(VERTC.events.onRemoteAudioPropertiesReport, handleRemoteAudioPropertiesReport)
    engine.on(VERTC.events.onError, handleRtcError)
  } catch (error) {
    closed = true
    VERTC.destroyEngine(engine)
    throw error
  }

  const performLeave = async () => {
    clearQuietTimer()
    try {
      engine.setCaptureVolume(StreamIndex.STREAM_INDEX_MAIN, MUTED_CAPTURE_VOLUME)
      await engine.stopAudioCapture()
    } catch (error) {
      config.onLog(`清理时停止音频采集失败：${String(error)}`)
    }
    // An SDK join/capture may already be in flight. Its continuation checks
    // closed before doing more work, then this cleanup closes the settled room.
    if (joining) await joining.catch(() => undefined)
    if (destroyed) return
    config.onRoomStateChange('leaving')
    clearQuietTimer()
    try {
      if (joined) {
        await engine.unpublishStream(MediaType.AUDIO)
      }
    } catch (error) {
      config.onLog(`清理时取消发布本地音频失败：${String(error)}`)
    }
    try {
      await engine.stopAudioCapture()
    } catch (error) {
      config.onLog(`清理时停止音频采集失败：${String(error)}`)
    }
    try {
      if (joined) {
        await engine.leaveRoom()
      }
    } finally {
      joined = false
      manuallyMuted = false
      feedbackProtectionEnabled = config.feedbackProtectionEnabled ?? true
      inputSuppressed = false
      emitAiSpeaking(false)
      config.onInputSuppressionChange?.(false)
      config.onRemoteAudioTrack(null)
      config.onRoomStateChange('left')
    }
  }

  const leave = () => {
    closed = true
    clearQuietTimer()
    if (!leaving) leaving = performLeave()
    return leaving
  }

  return {
    joinAndPublish() {
      if (joining) return joining
      joining = (async () => {
        assertCurrent()
        config.onRoomStateChange('joining')
        await engine.setAudioProfile(AudioProfileType.fluent)
        assertCurrent()
        engine.enableAudioPropertiesReport({ interval: 300, enableInBackground: true })
        await engine.joinRoom(
          config.token,
          config.roomId,
          { userId: config.userId },
          {
            isAutoPublish: false,
            isAutoSubscribeAudio: false,
            isAutoSubscribeVideo: false,
          },
        )
        joined = true
        assertCurrent()
        config.onRoomStateChange('joined')
        config.onLog('已加入 RTC 房间。')

        await engine.startAudioCapture()
        assertCurrent()
        await engine.publishStream(MediaType.AUDIO)
        assertCurrent()
        manuallyMuted = false
        applyCapturePolicy()
        config.onLog('本地麦克风已开始采集并发布。')
      })().finally(() => { joining = null })
      return joining
    },

    async mute() {
      if (!isCurrent() || !joined || manuallyMuted) {
        return
      }
      manuallyMuted = true
      applyCapturePolicy()
      config.onLog('本地麦克风已静音。')
    },

    async unmute() {
      if (!isCurrent() || !joined || !manuallyMuted) {
        return
      }
      manuallyMuted = false
      applyCapturePolicy()
      config.onLog(
        inputSuppressed
          ? '本地麦克风已取消静音，但 AI 正在说话，回灌防护仍在抑制输入。'
          : '本地麦克风已取消静音。',
      )
    },

    leave,

    destroy() {
      if (destroyed) return
      destroyed = true
      closed = true
      joined = false
      clearQuietTimer()
      try {
        engine.off(VERTC.events.onConnectionStateChanged, handleConnectionStateChanged)
        engine.off(VERTC.events.onUserJoined, handleUserJoined)
        engine.off(VERTC.events.onUserLeave, handleUserLeave)
        engine.off(VERTC.events.onUserPublishStream, handleUserPublishStream)
        engine.off(VERTC.events.onUserUnpublishStream, handleUserUnpublishStream)
        engine.off(VERTC.events.onRemoteAudioPropertiesReport, handleRemoteAudioPropertiesReport)
        engine.off(VERTC.events.onError, handleRtcError)
      } finally {
        VERTC.destroyEngine(engine)
      }
    },

    isJoined() {
      return joined && !closed && !destroyed
    },

    isMuted() {
      return manuallyMuted
    },

    isAiSpeaking() {
      return aiSpeaking
    },

    isInputSuppressed() {
      return inputSuppressed
    },

    setFeedbackProtectionEnabled(enabled: boolean) {
      if (!isCurrent()) return
      feedbackProtectionEnabled = enabled
      applyCapturePolicy()
      config.onLog(
        enabled
          ? '已开启回灌防护。'
          : '已关闭回灌防护，AI 说话时不会再自动抑制麦克风输入。',
      )
    },

    isFeedbackProtectionEnabled() {
      return feedbackProtectionEnabled
    },
  }
}
