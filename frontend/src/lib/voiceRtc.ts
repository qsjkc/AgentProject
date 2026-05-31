import VERTC, {
  AudioProfileType,
  ConnectionState,
  MediaType,
  StreamIndex,
  type ConnectionStateChangeEvent,
  type IRTCEngine,
  type RemoteAudioPropertiesInfo,
  type onUserJoinedEvent,
  type onUserLeaveEvent,
} from '@volcengine/rtc'

export interface VoiceRtcSessionConfig {
  appId: string
  roomId: string
  userId: string
  aiUserId: string
  token: string
  feedbackProtectionEnabled?: boolean
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

const audioFlag = Number(MediaType.AUDIO)
const AI_SPEAKING_THRESHOLD = 35
const AI_QUIET_HOLD_MS = 1200
const ACTIVE_CAPTURE_VOLUME = 100
const MUTED_CAPTURE_VOLUME = 0
const AI_REMOTE_PLAYBACK_VOLUME = 85

function hasAudio(mediaType: MediaType | number) {
  return (Number(mediaType) & audioFlag) === audioFlag
}

async function waitForRemoteAudioTrack(
  engine: IRTCEngine,
  aiUserId: string,
  onRemoteAudioTrack: (track: MediaStreamTrack | null) => void,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const track = engine.getRemoteStreamTrack(aiUserId, StreamIndex.STREAM_INDEX_MAIN, 'audio')
    if (track) {
      onRemoteAudioTrack(track)
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200))
  }
  onRemoteAudioTrack(null)
}

function extractAiLinearVolume(event: RemoteAudioPropertiesInfo[], aiUserId: string) {
  const aiInfo = event.find((item) => item.streamKey.userId === aiUserId)
  return aiInfo?.audioPropertiesInfo.linearVolume ?? 0
}

export async function isRtcSupported() {
  return VERTC.isSupported()
}

export async function createVoiceRtcSession(config: VoiceRtcSessionConfig): Promise<VoiceRtcSessionHandle> {
  const engine = VERTC.createEngine(config.appId)
  let joined = false
  let manuallyMuted = false
  let aiSpeaking = false
  let inputSuppressed = false
  let feedbackProtectionEnabled = config.feedbackProtectionEnabled ?? true
  let quietTimer: number | null = null

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
    const label = ConnectionState[event.state] ?? String(event.state)
    config.onConnectionStateChange(label)
    config.onLog(`RTC 连接状态 -> ${label}`)
  }

  const handleUserJoined = (event: onUserJoinedEvent) => {
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
    if (event.userInfo.userId === config.aiUserId) {
      config.onRemoteAudioTrack(null)
      resetAiSpeechState()
      config.onLog('AI 用户已离开房间。')
    }
  }

  const handleUserPublishStream = async (event: { userId: string; mediaType: MediaType | number }) => {
    if (event.userId !== config.aiUserId || !hasAudio(event.mediaType)) {
      return
    }
    try {
      await engine.subscribeStream(event.userId, MediaType.AUDIO)
      engine.setPlaybackVolume(config.aiUserId, StreamIndex.STREAM_INDEX_MAIN, AI_REMOTE_PLAYBACK_VOLUME)
      config.onLog('已订阅 AI 远端音频。')
      await waitForRemoteAudioTrack(engine, config.aiUserId, config.onRemoteAudioTrack)
    } catch (error) {
      config.onError(`订阅 AI 音频失败：${String(error)}`)
    }
  }

  const handleUserUnpublishStream = (event: { userId: string }) => {
    if (event.userId === config.aiUserId) {
      config.onRemoteAudioTrack(null)
      resetAiSpeechState()
      config.onLog('AI 远端音频已取消发布。')
    }
  }

  const handleRemoteAudioPropertiesReport = (event: RemoteAudioPropertiesInfo[]) => {
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
      emitAiSpeaking(false)
      applyCapturePolicy()
    }, AI_QUIET_HOLD_MS)
  }

  const handleRtcError = (event: { errorCode?: string | number }) => {
    config.onError(`RTC 错误：${String(event.errorCode ?? 'unknown')}`)
  }

  engine.on(VERTC.events.onConnectionStateChanged, handleConnectionStateChanged)
  engine.on(VERTC.events.onUserJoined, handleUserJoined)
  engine.on(VERTC.events.onUserLeave, handleUserLeave)
  engine.on(VERTC.events.onUserPublishStream, handleUserPublishStream)
  engine.on(VERTC.events.onUserUnpublishStream, handleUserUnpublishStream)
  engine.on(VERTC.events.onRemoteAudioPropertiesReport, handleRemoteAudioPropertiesReport)
  engine.on(VERTC.events.onError, handleRtcError)

  const leave = async () => {
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

  return {
    async joinAndPublish() {
      config.onRoomStateChange('joining')
      await engine.setAudioProfile(AudioProfileType.fluent)
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
      config.onRoomStateChange('joined')
      config.onLog('已加入 RTC 房间。')

      await engine.startAudioCapture()
      await engine.publishStream(MediaType.AUDIO)
      manuallyMuted = false
      applyCapturePolicy()
      config.onLog('本地麦克风已开始采集并发布。')
    },

    async mute() {
      if (!joined || manuallyMuted) {
        return
      }
      manuallyMuted = true
      applyCapturePolicy()
      config.onLog('本地麦克风已静音。')
    },

    async unmute() {
      if (!joined || !manuallyMuted) {
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
      clearQuietTimer()
      engine.off(VERTC.events.onConnectionStateChanged, handleConnectionStateChanged)
      engine.off(VERTC.events.onUserJoined, handleUserJoined)
      engine.off(VERTC.events.onUserLeave, handleUserLeave)
      engine.off(VERTC.events.onUserPublishStream, handleUserPublishStream)
      engine.off(VERTC.events.onUserUnpublishStream, handleUserUnpublishStream)
      engine.off(VERTC.events.onRemoteAudioPropertiesReport, handleRemoteAudioPropertiesReport)
      engine.off(VERTC.events.onError, handleRtcError)
      VERTC.destroyEngine(engine)
    },

    isJoined() {
      return joined
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
