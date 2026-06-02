import VERTC, { AudioProfileType, MediaType, StreamIndex } from '@volcengine/rtc'

import {
  createVoiceDemoSession,
  getVoiceDemoSession,
  interruptVoiceDemoSession,
  startVoiceDemoSession,
  stopVoiceDemoSession,
} from './voice-api'
import { isVoiceAuthError } from './voice-errors'
import {
  formatVoiceError,
  normalizeDisplayText,
  normalizeRtsSubtitleItems,
  normalizeSubtitleItems,
} from './voice-format'
import { DEFAULT_VOICE_SETTINGS, VOICE_OUTPUT_MODES, normalizeVoiceSettings } from './voice-state'

const ACTIVE_CAPTURE_VOLUME = 100
const IDLE_CAPTURE_VOLUME = 0
const REMOTE_PLAYBACK_VOLUME = 100
const INACTIVITY_TIMEOUT_MS = 30_000
const POST_TALK_DRAIN_MS = 220
const REMOTE_TRACK_WAIT_ATTEMPTS = 12
const REMOTE_TRACK_WAIT_INTERVAL_MS = 200
const HIDDEN_AUDIO_ID = 'detachym-desktop-voice-audio'

function sleep(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs)
  })
}

function hasAudio(mediaType) {
  return (Number(mediaType) & Number(MediaType.AUDIO)) === Number(MediaType.AUDIO)
}

function ensureHiddenAudioElement() {
  let element = document.getElementById(HIDDEN_AUDIO_ID)
  if (element instanceof HTMLAudioElement) {
    return element
  }

  element = document.createElement('audio')
  element.id = HIDDEN_AUDIO_ID
  element.autoplay = true
  element.playsInline = true
  element.controls = false
  element.style.position = 'fixed'
  element.style.width = '1px'
  element.style.height = '1px'
  element.style.opacity = '0'
  element.style.pointerEvents = 'none'
  element.style.left = '-9999px'
  element.style.top = '-9999px'
  document.body.appendChild(element)
  return element
}

function makeSessionNotActiveError() {
  return {
    accepted: false,
    lastAction: 'interrupt',
    lastError: 'session not active or already cleaned up',
  }
}

function buildDesktopVoiceSession(options = {}) {
  const callbacks = {
    onLog: options.onLog || (() => {}),
    onEvent: options.onEvent || (() => {}),
    onError: options.onError || (() => {}),
    onReplyPartial: options.onReplyPartial || (() => {}),
    onReplyFinal: options.onReplyFinal || (() => {}),
    onCleanup: options.onCleanup || (() => {}),
  }

  let settings = normalizeVoiceSettings(options.settings || DEFAULT_VOICE_SETTINGS)
  let engine = null
  let session = null
  let joined = false
  let listening = false
  let localAudioCapturing = false
  let localAudioPublished = false
  let cleaningUp = null
  let starting = null
  let destroyed = false
  let inactivityTimer = null
  let remoteAudioElement = ensureHiddenAudioElement()
  let currentSubtitleSequence = null
  let boundListeners = null

  const emitEvent = (event, details = {}) => {
    callbacks.onEvent(event, details)
    callbacks.onLog(event, details)
  }

  const emitError = (message, details = {}) => {
    callbacks.onError({
      message,
      fatal: details.fatal ?? true,
      phase: details.phase || 'unknown',
      details,
    })
  }

  const clearInactivityTimer = () => {
    if (inactivityTimer !== null) {
      window.clearTimeout(inactivityTimer)
      inactivityTimer = null
    }
  }

  const resetInactivityTimer = () => {
    clearInactivityTimer()
    inactivityTimer = window.setTimeout(() => {
      void shutdownVoiceSession({ reason: 'inactivity-timeout' })
    }, INACTIVITY_TIMEOUT_MS)
  }

  const applyOutputMode = () => {
    if (!remoteAudioElement) {
      return
    }
    const shouldPlay = settings.desktop_voice_output_mode === VOICE_OUTPUT_MODES.VOICE_AND_TEXT
    remoteAudioElement.muted = !shouldPlay
    remoteAudioElement.volume = shouldPlay ? 1 : 0
    if (engine && session?.aiUserId) {
      engine.setPlaybackVolume(
        session.aiUserId,
        StreamIndex.STREAM_INDEX_MAIN,
        shouldPlay ? REMOTE_PLAYBACK_VOLUME : 0,
      )
    }
  }

  const clearRemoteAudio = () => {
    if (!remoteAudioElement) {
      return
    }
    remoteAudioElement.pause()
    remoteAudioElement.srcObject = null
  }

  const attachRemoteAudioTrack = async () => {
    if (!engine || !session || !remoteAudioElement) {
      return false
    }

    for (let attempt = 0; attempt < REMOTE_TRACK_WAIT_ATTEMPTS; attempt += 1) {
      const track = engine.getRemoteStreamTrack(session.aiUserId, StreamIndex.STREAM_INDEX_MAIN, 'audio')
      if (track) {
        remoteAudioElement.srcObject = new MediaStream([track])
        applyOutputMode()
        try {
          await remoteAudioElement.play()
        } catch (error) {
          emitError(formatVoiceError(error, '自动播放 AI 回复语音失败。'), {
            fatal: false,
            phase: 'remote-audio-playback',
          })
        }
        emitEvent('voice:remote-audio-attached', {
          mode: settings.desktop_voice_output_mode,
          aiUserId: session.aiUserId,
        })
        return true
      }
      await sleep(REMOTE_TRACK_WAIT_INTERVAL_MS)
    }

    emitEvent('voice:remote-audio-missing', {
      aiUserId: session.aiUserId,
    })
    return false
  }

  const setCaptureVolume = (volume) => {
    if (!engine) {
      return
    }
    engine.setCaptureVolume(StreamIndex.STREAM_INDEX_MAIN, volume)
  }

  const bindEngineListeners = () => {
    if (!engine || !session) {
      return
    }

    const handleSubtitleStateChanged = (payload) => {
      emitEvent('voice:subtitle-state', {
        event: payload?.event ?? null,
        errorCode: payload?.errorCode ?? null,
        errorMessage: payload?.errorMessage ?? null,
      })
      if (payload?.errorCode || payload?.errorMessage) {
        emitError(formatVoiceError(payload?.errorMessage || payload?.errorCode, '字幕服务暂时不可用。'), {
          fatal: false,
          phase: 'subtitle',
          errorCode: payload?.errorCode ?? null,
        })
      }
    }

    const processSubtitleItems = (items, source, rawDetails = {}) => {
      emitEvent('voice:subtitle-message', {
        source,
        count: items.length,
        speakers: [...new Set(items.map((item) => item.speakerId || 'unknown'))],
        ...rawDetails,
      })

      for (const item of items) {
        const text = normalizeDisplayText(item.text)
        if (!text) {
          continue
        }

        const speakerId = item.speakerId || null
        const isLocalSpeaker = Boolean(speakerId && speakerId === session.userId)
        const isAiSpeaker = Boolean(speakerId && speakerId === session.aiUserId)
        const isRemoteCandidate = isAiSpeaker || Boolean(speakerId && speakerId !== session.userId)

        if (isLocalSpeaker || !isRemoteCandidate) {
          emitEvent('voice:subtitle-ignored', {
            speakerId,
            reason: isLocalSpeaker ? 'local-speaker' : 'unknown-speaker',
            final: item.isFinal,
          })
          continue
        }

        resetInactivityTimer()

        if (item.isFinal) {
          currentSubtitleSequence = item.sequence ?? currentSubtitleSequence
          callbacks.onReplyFinal({
            text,
            speakerId,
            isAiSpeaker,
            sequence: item.sequence ?? null,
          })
          emitEvent('voice:reply-final', {
            speakerId,
            isAiSpeaker,
            sequence: item.sequence ?? null,
            textPreview: text.slice(0, 80),
          })
          resetInactivityTimer()
          continue
        }

        if (currentSubtitleSequence !== null && item.sequence === currentSubtitleSequence) {
          continue
        }

        callbacks.onReplyPartial({
          text,
          speakerId,
          isAiSpeaker,
          sequence: item.sequence ?? null,
        })
      }
    }

    const handleSubtitleMessageReceived = (payload) => {
      processSubtitleItems(normalizeSubtitleItems(payload), 'sdk-subtitle', {
        rawType: Array.isArray(payload) ? 'array' : typeof payload,
        rawKeys: payload && !Array.isArray(payload) && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
      })
    }

    const handleRoomBinaryMessageReceived = (event) => {
      const items = normalizeRtsSubtitleItems(event?.message)
      if (!items.length) {
        emitEvent('voice:room-binary-message', {
          userId: event?.userId ?? null,
          byteLength: event?.message?.byteLength ?? event?.message?.length ?? null,
          parsed: false,
        })
        return
      }

      processSubtitleItems(items, 'rts-subtitle', {
        userId: event?.userId ?? null,
        byteLength: event?.message?.byteLength ?? event?.message?.length ?? null,
      })
    }

    const handleRoomMessageReceived = (event) => {
      let payload = event?.message
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload)
        } catch {
          emitEvent('voice:room-message', {
            userId: event?.userId ?? null,
            parsed: false,
            textLength: payload.length,
          })
          return
        }
      }

      processSubtitleItems(normalizeSubtitleItems(payload), 'room-message', {
        userId: event?.userId ?? null,
        rawType: typeof payload,
      })
    }

    const handleUserPublishStream = async (event) => {
      if (!session || event.userId !== session.aiUserId || !hasAudio(event.mediaType)) {
        return
      }

      try {
        await engine.subscribeStream(event.userId, MediaType.AUDIO)
        applyOutputMode()
        resetInactivityTimer()
        await attachRemoteAudioTrack()
      } catch (error) {
        emitError(formatVoiceError(error, '订阅 AI 远端音频失败。'), {
          fatal: false,
          phase: 'remote-audio-subscribe',
        })
      }
    }

    const handleUserUnpublishStream = (event) => {
      if (session && event.userId === session.aiUserId) {
        clearRemoteAudio()
      }
    }

    const handleUserLeave = (event) => {
      if (session && event.userInfo?.userId === session.aiUserId) {
        clearRemoteAudio()
      }
    }

    const handleAutoplayFailed = () => {
      emitError('系统阻止了 AI 回复语音自动播放。', {
        fatal: false,
        phase: 'autoplay',
      })
    }

    const handleRtcError = (event) => {
      emitError(`RTC 错误：${String(event?.errorCode ?? 'unknown')}`, {
        phase: 'rtc',
      })
    }

    engine.on(VERTC.events.onSubtitleStateChanged, handleSubtitleStateChanged)
    engine.on(VERTC.events.onSubtitleMessageReceived, handleSubtitleMessageReceived)
    engine.on(VERTC.events.onRoomBinaryMessageReceived, handleRoomBinaryMessageReceived)
    engine.on(VERTC.events.onRoomMessageReceived, handleRoomMessageReceived)
    engine.on(VERTC.events.onUserPublishStream, handleUserPublishStream)
    engine.on(VERTC.events.onUserUnpublishStream, handleUserUnpublishStream)
    engine.on(VERTC.events.onUserLeave, handleUserLeave)
    engine.on(VERTC.events.onAutoplayFailed, handleAutoplayFailed)
    engine.on(VERTC.events.onError, handleRtcError)

    boundListeners = {
      handleSubtitleStateChanged,
      handleSubtitleMessageReceived,
      handleRoomBinaryMessageReceived,
      handleRoomMessageReceived,
      handleUserPublishStream,
      handleUserUnpublishStream,
      handleUserLeave,
      handleAutoplayFailed,
      handleRtcError,
    }
  }

  const unbindEngineListeners = () => {
    if (!engine || !boundListeners) {
      return
    }

    engine.off(VERTC.events.onSubtitleStateChanged, boundListeners.handleSubtitleStateChanged)
    engine.off(VERTC.events.onSubtitleMessageReceived, boundListeners.handleSubtitleMessageReceived)
    engine.off(VERTC.events.onRoomBinaryMessageReceived, boundListeners.handleRoomBinaryMessageReceived)
    engine.off(VERTC.events.onRoomMessageReceived, boundListeners.handleRoomMessageReceived)
    engine.off(VERTC.events.onUserPublishStream, boundListeners.handleUserPublishStream)
    engine.off(VERTC.events.onUserUnpublishStream, boundListeners.handleUserUnpublishStream)
    engine.off(VERTC.events.onUserLeave, boundListeners.handleUserLeave)
    engine.off(VERTC.events.onAutoplayFailed, boundListeners.handleAutoplayFailed)
    engine.off(VERTC.events.onError, boundListeners.handleRtcError)
    boundListeners = null
  }

  const ensureMicPermission = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风采集。')
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
  }

  const ensureActiveSession = async () => {
    if (destroyed) {
      throw new Error('桌宠语音会话已经销毁。')
    }

    if (joined && session?.sessionId) {
      try {
        const status = await getVoiceDemoSession(session.sessionId)
        if (status?.sessionActive && status?.state === 'active') {
          resetInactivityTimer()
          return { session, status, reused: true }
        }
      } catch (error) {
        if (isVoiceAuthError(error)) {
          throw error
        }
        emitEvent('voice:session-status-stale', {
          sessionId: session?.sessionId ?? null,
        })
      }

      await shutdownVoiceSession({ reason: 'stale-session' })
    }

    if (starting) {
      return starting
    }

    starting = (async () => {
      emitEvent('voice:session-create')
      try {
        await ensureMicPermission()
      } catch (error) {
        emitEvent('voice:mic-permission-error', {
          message: formatVoiceError(error, '麦克风权限检查失败。'),
        })
        throw error
      }

      if (!(await VERTC.isSupported())) {
        throw new Error('当前环境不支持火山 RTC。')
      }

      const createdSession = await createVoiceDemoSession()
      session = createdSession
      currentSubtitleSequence = null

      engine = VERTC.createEngine(createdSession.appId)
      bindEngineListeners()

      await engine.setAudioProfile(AudioProfileType.fluent)
      await engine.joinRoom(
        createdSession.token,
        createdSession.roomId,
        { userId: createdSession.userId },
        {
          isAutoPublish: false,
          isAutoSubscribeAudio: false,
          isAutoSubscribeVideo: false,
        },
      )
      joined = true
      emitEvent('voice:rtc-join', {
        roomId: createdSession.roomId,
        userId: createdSession.userId,
      })

      localAudioCapturing = false
      localAudioPublished = false
      setCaptureVolume(IDLE_CAPTURE_VOLUME)

      const startedSession = await startVoiceDemoSession(createdSession.sessionId)
      emitEvent('voice:session-start', {
        sessionId: createdSession.sessionId,
        state: startedSession?.state ?? createdSession.state ?? null,
      })

      resetInactivityTimer()
      return {
        session: createdSession,
        status: startedSession,
        reused: false,
      }
    })().finally(() => {
      starting = null
    })

    return starting
  }

  async function enterVoiceMode() {
    const result = await ensureActiveSession()
    resetInactivityTimer()
    return {
      sessionId: result.session.sessionId,
      aiUserId: result.session.aiUserId,
      userId: result.session.userId,
      outputMode: settings.desktop_voice_output_mode,
      reused: result.reused,
    }
  }

  async function startPressToTalk() {
    const result = await ensureActiveSession()
    if (!engine || !joined) {
      throw new Error('语音连接尚未就绪。')
    }

    try {
      listening = true
      currentSubtitleSequence = null
      if (!localAudioCapturing) {
        await engine.startAudioCapture()
        localAudioCapturing = true
        emitEvent('voice:local-audio-start', {
          mode: 'push-to-talk',
        })
      }
      if (!localAudioPublished) {
        await engine.publishStream(MediaType.AUDIO)
        localAudioPublished = true
        emitEvent('voice:local-audio-publish', {
          mode: 'push-to-talk',
        })
      }
      setCaptureVolume(ACTIVE_CAPTURE_VOLUME)
      emitEvent('voice:key-down', {
        sessionId: result.session.sessionId,
      })
      resetInactivityTimer()
      return { accepted: true }
    } catch (error) {
      listening = false
      try {
        setCaptureVolume(IDLE_CAPTURE_VOLUME)
      } catch {
        // best effort
      }
      if (localAudioPublished) {
        try {
          await engine.unpublishStream(MediaType.AUDIO)
        } catch {
          // best effort
        } finally {
          localAudioPublished = false
        }
      }
      if (localAudioCapturing) {
        try {
          await engine.stopAudioCapture()
        } catch {
          // best effort
        } finally {
          localAudioCapturing = false
        }
      }
      throw error
    }
  }

  async function stopPressToTalk() {
    if (!engine || !joined || !listening) {
      return { accepted: false }
    }

    listening = false
    await sleep(POST_TALK_DRAIN_MS)
    setCaptureVolume(IDLE_CAPTURE_VOLUME)
    if (localAudioPublished) {
      try {
        await engine.unpublishStream(MediaType.AUDIO)
      } finally {
        localAudioPublished = false
        emitEvent('voice:local-audio-unpublish', {
          mode: 'push-to-talk',
        })
      }
    }
    if (localAudioCapturing) {
      try {
        await engine.stopAudioCapture()
      } finally {
        localAudioCapturing = false
      }
    }
    emitEvent('voice:key-up', {
      sessionId: session?.sessionId ?? null,
    })
    emitEvent('voice:local-audio-stop', {
      mode: 'push-to-talk',
    })
    resetInactivityTimer()
    return { accepted: true }
  }

  async function interruptVoiceReply() {
    resetInactivityTimer()
    if (!session?.sessionId) {
      return makeSessionNotActiveError()
    }

    try {
      const result = await interruptVoiceDemoSession(session.sessionId)
      emitEvent('voice:interrupt', {
        sessionId: session.sessionId,
        accepted: result?.accepted ?? false,
      })
      return result
    } catch (error) {
      const message = formatVoiceError(error, '打断当前回复失败。')
      emitError(message, {
        fatal: false,
        phase: 'interrupt',
      })
      return {
        accepted: false,
        lastAction: 'interrupt',
        lastError: message,
      }
    }
  }

  async function shutdownVoiceSession(options = {}) {
    const { reason = 'manual' } = options

    if (cleaningUp) {
      return cleaningUp
    }

    cleaningUp = (async () => {
      clearInactivityTimer()
      listening = false

      if (engine && joined) {
        try {
          setCaptureVolume(IDLE_CAPTURE_VOLUME)
        } catch {
          // ignore
        }
      }

      if (session?.sessionId) {
        try {
          const result = await stopVoiceDemoSession(session.sessionId)
          emitEvent('voice:stop', {
            sessionId: session.sessionId,
            cleanupPending: Boolean(result?.cleanupPending),
            reason,
          })
        } catch (error) {
          emitError(formatVoiceError(error, '停止语音会话失败。'), {
            fatal: false,
            phase: 'stop',
          })
        }
      }

      if (engine) {
        try {
          engine.stopSubtitle()
        } catch {
          // best effort
        }

        try {
          if (joined && localAudioPublished) {
            await engine.unpublishStream(MediaType.AUDIO)
          }
        } catch {
          // best effort
        } finally {
          localAudioPublished = false
        }

        try {
          if (localAudioCapturing) {
            await engine.stopAudioCapture()
          }
        } catch {
          // best effort
        } finally {
          localAudioCapturing = false
        }

        try {
          if (joined) {
            await engine.leaveRoom()
          }
        } catch {
          // best effort
        }

        emitEvent('voice:rtc-leave', {
          sessionId: session?.sessionId ?? null,
          reason,
        })
        joined = false
        unbindEngineListeners()
        VERTC.destroyEngine(engine)
        engine = null
      }

      clearRemoteAudio()
      const previousSessionId = session?.sessionId ?? null
      session = null
      currentSubtitleSequence = null
      callbacks.onCleanup({
        reason,
        sessionId: previousSessionId,
      })
    })().finally(() => {
      cleaningUp = null
    })

    return cleaningUp
  }

  function updateSettings(patch = {}) {
    settings = normalizeVoiceSettings({
      ...settings,
      ...patch,
    })
    applyOutputMode()
    return settings
  }

  function getSettings() {
    return settings
  }

  function destroy() {
    destroyed = true
    clearInactivityTimer()
    clearRemoteAudio()
    if (remoteAudioElement?.id === HIDDEN_AUDIO_ID) {
      remoteAudioElement.remove()
    }
    remoteAudioElement = null
  }

  applyOutputMode()

  return {
    enterVoiceMode,
    startPressToTalk,
    stopPressToTalk,
    interruptVoiceReply,
    shutdownVoiceSession,
    updateSettings,
    getSettings,
    destroy,
  }
}

let sharedDesktopVoiceSession = null

export function createDesktopVoiceSession(options = {}) {
  if (sharedDesktopVoiceSession) {
    void sharedDesktopVoiceSession.shutdownVoiceSession({ reason: 'replace-session-manager' }).catch(() => undefined)
    sharedDesktopVoiceSession.destroy()
  }
  sharedDesktopVoiceSession = buildDesktopVoiceSession(options)
  return sharedDesktopVoiceSession
}

function requireSharedSession() {
  if (!sharedDesktopVoiceSession) {
    throw new Error('Desktop voice session has not been created.')
  }
  return sharedDesktopVoiceSession
}

export function enterVoiceMode() {
  return requireSharedSession().enterVoiceMode()
}

export function startPressToTalk() {
  return requireSharedSession().startPressToTalk()
}

export function stopPressToTalk() {
  return requireSharedSession().stopPressToTalk()
}

export function interruptVoiceReply() {
  return requireSharedSession().interruptVoiceReply()
}

export function shutdownVoiceSession(options = {}) {
  return requireSharedSession().shutdownVoiceSession(options)
}
