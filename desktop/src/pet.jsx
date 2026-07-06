import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { PetAnimator } from './components/PetAnimator'
import { getLanguage, getSessionToken, getVoiceSettings } from './shared/api'
import { formatVoiceError, truncateForPetBubble } from './shared/voice-format'
import { getPetVoiceCopy } from './shared/pet-voice-copy'
import { isVoiceAuthError } from './shared/voice-errors'
import { createDesktopVoiceSession } from './shared/voice-rtc'
import { createVoiceDebugLogger } from './shared/voice-debug'
import {
  createInitialVoiceUiState,
  DEFAULT_VOICE_SETTINGS,
  isVoiceUiActive,
  normalizeVoiceSettings,
  VOICE_PHASES,
  voiceStateReducer,
} from './shared/voice-state'
import { getMessagePool, getPetMessagePool, normalizeLanguage, t } from './shared/i18n'
import {
  createInitialPetAnimationState,
  petAnimationReducer,
} from './shared/pet-animation-state'
import { getPetReminderCopy } from './shared/pet-personality'
import { getPetVisual } from './shared/pets'
import { completeReminder, getPendingReminders } from './shared/reminders-api'

const DEFAULT_PREFERENCES = {
  quick_chat_enabled: true,
  bubble_frequency: 120,
}

const DRAG_THRESHOLD = 8
const REPLY_VISIBLE_MS = 8000
const PROCESSING_TIMEOUT_MS = 18000
const AUTH_EXPIRED_BUBBLE_MS = 4200
const REMINDER_POLL_INTERVAL_MS = 30000
const PET_IDLE_ANIMATION_INTERVAL_MS = 45000
const PET_SLEEP_TIMEOUT_MS = 10 * 60 * 1000

function pickRandom(items) {
  if (!items.length) {
    return ''
  }

  return items[Math.floor(Math.random() * items.length)]
}

function getVoiceIntroHint(language) {
  if (language === 'zh-CN') {
    return '单击进入语音态，按住 D 说话，松开结束；拖动可以移动桌宠。'
  }

  return 'Single click enters voice mode. Hold D to talk, release to send, and drag to move the pet.'
}

function getQuickChatEntryHint(language) {
  if (language === 'zh-CN') {
    return '文字聊天仍然保留在托盘菜单和主面板里。'
  }

  return 'Text chat stays available from the tray menu and the main panel.'
}

function getAuthExpiredMessage(language) {
  return language === 'zh-CN'
    ? '登录已过期，请打开主面板重新登录。'
    : 'Your login has expired. Open the main panel and sign in again.'
}

function PetApp() {
  const [petType, setPetType] = useState('cat')
  const [language, setLanguageState] = useState('zh-CN')
  const [hasSession, setHasSession] = useState(false)
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES)
  const [voiceSettings, setVoiceSettings] = useState(DEFAULT_VOICE_SETTINGS)
  const [transientBubble, setTransientBubble] = useState('')
  const [hovering, setHovering] = useState(false)
  const [voiceUiState, dispatchVoice] = useReducer(voiceStateReducer, undefined, createInitialVoiceUiState)
  const [petAnimationState, dispatchPetAnimation] = useReducer(
    petAnimationReducer,
    undefined,
    createInitialPetAnimationState,
  )

  const managerRef = useRef(null)
  const keyHeldRef = useRef(false)
  const transientBubbleTimerRef = useRef(null)
  const idleBubbleTimerRef = useRef(null)
  const uiIdleTimerRef = useRef(null)
  const processingTimerRef = useRef(null)
  const replyTimerRef = useRef(null)
  const sleepTimerRef = useRef(null)
  const previousSessionRef = useRef(null)
  const previousPhaseRef = useRef(VOICE_PHASES.IDLE)
  const phaseRef = useRef(VOICE_PHASES.IDLE)
  const transientBubbleRef = useRef(transientBubble)
  const languageRef = useRef(language)
  const petTypeRef = useRef(petType)
  const voiceSettingsRef = useRef(voiceSettings)
  const hasSessionRef = useRef(hasSession)
  const petPositionRef = useRef({ x: 90, y: 90 })
  const loggerRef = useRef(
    createVoiceDebugLogger((payload) => {
      void window.desktopBridge?.logDebug?.({
        scope: 'desktop-pet-voice',
        ...payload,
      })
    }),
  )
  const suppressClickRef = useRef(false)
  const settlingPointerRef = useRef(false)
  const sendingPositionRef = useRef(false)
  const rafRef = useRef(null)
  const flushPromiseRef = useRef(null)
  const dragRef = useRef({
    pointerId: null,
    thresholdScreenX: 0,
    thresholdScreenY: 0,
    baseScreenX: 0,
    baseScreenY: 0,
    latestScreenX: 0,
    latestScreenY: 0,
    baseWindowX: 0,
    baseWindowY: 0,
    moved: false,
  })

  const clearTransientBubbleTimer = useCallback(() => {
    if (transientBubbleTimerRef.current) {
      window.clearTimeout(transientBubbleTimerRef.current)
      transientBubbleTimerRef.current = null
    }
  }, [])

  const clearUiIdleTimer = useCallback(() => {
    if (uiIdleTimerRef.current) {
      window.clearTimeout(uiIdleTimerRef.current)
      uiIdleTimerRef.current = null
    }
  }, [])

  const clearProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
      window.clearTimeout(processingTimerRef.current)
      processingTimerRef.current = null
    }
  }, [])

  const clearReplyTimer = useCallback(() => {
    if (replyTimerRef.current) {
      window.clearTimeout(replyTimerRef.current)
      replyTimerRef.current = null
    }
  }, [])

  const clearSleepTimer = useCallback(() => {
    if (sleepTimerRef.current) {
      window.clearTimeout(sleepTimerRef.current)
      sleepTimerRef.current = null
    }
  }, [])

  const resetPetActivityTimer = useCallback(() => {
    clearSleepTimer()
    sleepTimerRef.current = window.setTimeout(() => {
      if (
        phaseRef.current === VOICE_PHASES.IDLE &&
        dragRef.current.pointerId === null &&
        !transientBubbleRef.current &&
        !settlingPointerRef.current
      ) {
        dispatchPetAnimation({ type: 'SLEEP' })
      }
    }, PET_SLEEP_TIMEOUT_MS)
  }, [clearSleepTimer])

  const setTransientBubbleForDuration = useCallback(
    (text, duration = 2800) => {
      if (!text) {
        return
      }
      clearTransientBubbleTimer()
      setTransientBubble(text)
      transientBubbleRef.current = text
      transientBubbleTimerRef.current = window.setTimeout(() => {
        setTransientBubble('')
        transientBubbleRef.current = ''
        transientBubbleTimerRef.current = null
      }, duration)
      resetPetActivityTimer()
    },
    [clearTransientBubbleTimer, resetPetActivityTimer],
  )

  const getVoiceCopy = useCallback((key) => {
    return getPetVoiceCopy(languageRef.current, petTypeRef.current, key)
  }, [])

  const transitionToIdle = useCallback(() => {
    loggerRef.current.event('voice:exit', {
      from: phaseRef.current,
    })
    clearUiIdleTimer()
    clearProcessingTimer()
    clearReplyTimer()
    dispatchVoice({ type: 'VOICE_IDLE' })
  }, [clearProcessingTimer, clearReplyTimer, clearUiIdleTimer])

  const resetUiIdleTimer = useCallback(() => {
    clearUiIdleTimer()
    const timeoutMs = Math.max(
      3,
      Number(voiceSettingsRef.current?.desktop_voice_idle_timeout_seconds) || DEFAULT_VOICE_SETTINGS.desktop_voice_idle_timeout_seconds,
    ) * 1000

    uiIdleTimerRef.current = window.setTimeout(() => {
      if (phaseRef.current === VOICE_PHASES.VOICE_ARMED || phaseRef.current === VOICE_PHASES.READY) {
        dispatchVoice({ type: 'VOICE_IDLE' })
      }
    }, timeoutMs)
  }, [clearUiIdleTimer])

  const scheduleReplyAutoHide = useCallback(() => {
    clearReplyTimer()
    replyTimerRef.current = window.setTimeout(() => {
      dispatchVoice({ type: 'VOICE_IDLE' })
    }, REPLY_VISIBLE_MS)
  }, [clearReplyTimer])

  const scheduleProcessingTimeout = useCallback(() => {
    clearProcessingTimer()
    processingTimerRef.current = window.setTimeout(() => {
      dispatchVoice({
        type: 'VOICE_ERROR',
        bubbleText: getVoiceCopy('subtitleUnavailable'),
        errorMessage: getVoiceCopy('subtitleUnavailable'),
      })
    }, PROCESSING_TIMEOUT_MS)
  }, [clearProcessingTimer, getVoiceCopy])

  const handleFatalVoiceError = useCallback(
    (message) => {
      clearUiIdleTimer()
      clearProcessingTimer()
      clearReplyTimer()
      dispatchVoice({
        type: 'VOICE_ERROR',
        bubbleText: message,
        errorMessage: message,
      })
    },
    [clearProcessingTimer, clearReplyTimer, clearUiIdleTimer],
  )

  useEffect(() => {
    const previousPhase = previousPhaseRef.current
    phaseRef.current = voiceUiState.phase
    if (previousPhase !== voiceUiState.phase) {
      loggerRef.current.event('voice:state-change', {
        from: previousPhase,
        to: voiceUiState.phase,
      })
      previousPhaseRef.current = voiceUiState.phase
      resetPetActivityTimer()
    }
  }, [resetPetActivityTimer, voiceUiState.phase])

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    transientBubbleRef.current = transientBubble
  }, [transientBubble])

  useEffect(() => {
    petTypeRef.current = petType
  }, [petType])

  useEffect(() => {
    voiceSettingsRef.current = voiceSettings
  }, [voiceSettings])

  useEffect(() => {
    hasSessionRef.current = hasSession
  }, [hasSession])

  useEffect(() => {
    resetPetActivityTimer()
    return () => clearSleepTimer()
  }, [clearSleepTimer, resetPetActivityTimer])

  useEffect(() => {
    let mounted = true

    const syncState = async ({ refreshRemote = false } = {}) => {
      try {
        const [savedLanguage, token, bounds, storedPetState, storedVoiceSettings] = await Promise.all([
          getLanguage(),
          getSessionToken(),
          window.desktopBridge?.getPetBounds?.(),
          window.desktopBridge?.getPetState?.(),
          getVoiceSettings(),
        ])

        if (!mounted) {
          return
        }

        setLanguageState(normalizeLanguage(savedLanguage || storedPetState?.language))
        setHasSession(Boolean(token))
        setVoiceSettings(normalizeVoiceSettings(storedVoiceSettings))

        if (bounds?.x !== undefined && bounds?.y !== undefined) {
          petPositionRef.current = bounds
        }

        if (storedPetState?.petType) {
          setPetType(storedPetState.petType)
        }

        if (storedPetState?.preferences) {
          setPreferences({
            ...DEFAULT_PREFERENCES,
            ...storedPetState.preferences,
          })
        }

        if (!token) {
          return
        }

        if (!refreshRemote) {
          return
        }
      } catch {
        if (mounted) {
          setHasSession(false)
          setPetType('cat')
          setPreferences(DEFAULT_PREFERENCES)
          setVoiceSettings(DEFAULT_VOICE_SETTINGS)
        }
      }
    }

    const handleWindowFocus = () => {
      void syncState({ refreshRemote: false })
    }

    void syncState({ refreshRemote: true })
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      mounted = false
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [])

  useEffect(() => {
    const unsubscribePet = window.desktopBridge?.onPetStateChanged?.((payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }

      if (payload.language) {
        setLanguageState(normalizeLanguage(payload.language))
      }

      if (payload.petType) {
        setPetType(payload.petType)
      }

      if (payload.preferences) {
        setPreferences((current) => ({
          ...current,
          ...payload.preferences,
        }))
      }

      if (typeof payload.hasSession === 'boolean') {
        setHasSession(payload.hasSession)
      }
    })

    const unsubscribeVoice = window.desktopBridge?.onVoiceSettingsChanged?.((payload) => {
      const nextSettings = normalizeVoiceSettings(payload)
      setVoiceSettings(nextSettings)
      managerRef.current?.updateSettings?.(nextSettings)
    })

    return () => {
      unsubscribePet?.()
      unsubscribeVoice?.()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetReminderEvent?.((payload) => {
      if (!payload || payload.petType !== petTypeRef.current) {
        return
      }
      if (payload.type === 'created') {
        setTransientBubbleForDuration(payload.message, 3200)
        dispatchPetAnimation({ type: 'REMINDER_CREATED', message: payload.message })
        return
      }
      if (payload.type === 'parse_failed') {
        setTransientBubbleForDuration(payload.message, 3200)
        dispatchPetAnimation({ type: 'REMINDER_PARSE_FAILED', message: payload.message })
      }
    })

    return () => unsubscribe?.()
  }, [setTransientBubbleForDuration])

  useEffect(() => {
    const logger = loggerRef.current
    const manager = createDesktopVoiceSession({
      settings: voiceSettingsRef.current,
      getPetType: () => petTypeRef.current,
      onEvent: (event, details) => {
        logger.event(event, details)
      },
      onLog: () => {
        // events already go through the debug logger
      },
      onError: (payload) => {
        if (payload?.fatal === false) {
          logger.event('voice:warning', {
            phase: payload.phase,
            message: payload.message,
          })
          return
        }

        logger.event('voice:error', {
          phase: payload?.phase || 'unknown',
          message: payload?.message || 'voice error',
        })
        logger.error(
          payload?.phase || 'voice:error',
          new Error(payload?.message || 'voice error'),
          payload?.details || {},
        )
        handleFatalVoiceError(payload?.message || '语音连接失败。')
      },
      onReplyPartial: ({ text }) => {
        clearProcessingTimer()
        clearReplyTimer()
        dispatchVoice({
          type: 'VOICE_REPLYING',
          bubbleText: truncateForPetBubble(text, languageRef.current),
          errorMessage: '',
        })
      },
      onReplyFinal: ({ text }) => {
        clearProcessingTimer()
        clearUiIdleTimer()
        dispatchVoice({
          type: 'VOICE_REPLYING',
          bubbleText: truncateForPetBubble(text, languageRef.current),
          errorMessage: '',
        })
        scheduleReplyAutoHide()
      },
      onCleanup: ({ reason }) => {
        logger.event('voice:cleanup', { reason })
      },
    })

    managerRef.current = manager
    return () => {
      managerRef.current = null
      clearTransientBubbleTimer()
      clearUiIdleTimer()
      clearProcessingTimer()
      clearReplyTimer()
      void manager
        .shutdownVoiceSession({ reason: 'component-unmount' })
        .catch(() => undefined)
        .finally(() => {
          manager.destroy()
        })
    }
  }, [
    clearProcessingTimer,
    clearReplyTimer,
    clearTransientBubbleTimer,
    clearUiIdleTimer,
    handleFatalVoiceError,
    scheduleReplyAutoHide,
  ])

  useEffect(() => {
    if (previousSessionRef.current === null) {
      previousSessionRef.current = hasSession
      const introTimer = window.setTimeout(() => {
        setTransientBubbleForDuration(hasSession ? getVoiceIntroHint(language) : t(language, 'signInHint'), 3400)
      }, 700)

      return () => {
        window.clearTimeout(introTimer)
      }
    }

    if (previousSessionRef.current !== hasSession) {
      previousSessionRef.current = hasSession
      setTransientBubbleForDuration(hasSession ? getVoiceIntroHint(language) : t(language, 'signInHint'), 3400)
      if (!hasSession) {
        transitionToIdle()
        void managerRef.current?.shutdownVoiceSession?.({ reason: 'signed-out' })
      }
    }
  }, [hasSession, language, setTransientBubbleForDuration, transitionToIdle])

  useEffect(() => {
    if (idleBubbleTimerRef.current) {
      window.clearInterval(idleBubbleTimerRef.current)
      idleBubbleTimerRef.current = null
    }

    const frequencySeconds = Math.max(30, Number(preferences.bubble_frequency) || DEFAULT_PREFERENCES.bubble_frequency)
    idleBubbleTimerRef.current = window.setInterval(() => {
      if (
        phaseRef.current !== VOICE_PHASES.IDLE ||
        dragRef.current.pointerId !== null ||
        transientBubble ||
        settlingPointerRef.current
      ) {
        return
      }

      const pool = hasSessionRef.current
        ? getPetMessagePool(languageRef.current, petTypeRef.current, 'IdleMessages')
        : getMessagePool(languageRef.current, 'petSadMessages')
      setTransientBubbleForDuration(pickRandom(pool), 2800)
    }, frequencySeconds * 1000)

    return () => {
      if (idleBubbleTimerRef.current) {
        window.clearInterval(idleBubbleTimerRef.current)
        idleBubbleTimerRef.current = null
      }
    }
  }, [preferences.bubble_frequency, setTransientBubbleForDuration, transientBubble])

  useEffect(() => {
    let mounted = true
    let inFlight = false

    const poll = async () => {
      if (!hasSessionRef.current || inFlight) {
        return
      }
      inFlight = true
      try {
        const due = await getPendingReminders(petTypeRef.current, new Date())
        if (!mounted || !due.length) {
          return
        }
        const reminder = due[0]
        const copy = getPetReminderCopy(petTypeRef.current).reminderDue(reminder.title)
        setTransientBubbleForDuration(copy, 8000)
        dispatchPetAnimation({ type: 'REMINDER_DUE', message: copy })
        await window.desktopBridge?.showNotification?.({
          title: 'Detachym',
          body: copy,
        })
        await completeReminder(reminder.id)
      } catch (error) {
        loggerRef.current.error('reminder:poll-failed', error)
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = window.setInterval(poll, REMINDER_POLL_INTERVAL_MS)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [setTransientBubbleForDuration])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        phaseRef.current !== VOICE_PHASES.IDLE ||
        dragRef.current.pointerId !== null ||
        transientBubbleRef.current ||
        settlingPointerRef.current
      ) {
        return
      }
      dispatchPetAnimation({ type: 'IDLE_TICK' })
    }, PET_IDLE_ANIMATION_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  const stopCurrentListeningTurn = useCallback(async () => {
    if (phaseRef.current !== VOICE_PHASES.LISTENING) {
      return
    }

    keyHeldRef.current = false
    clearUiIdleTimer()
    clearReplyTimer()
    dispatchVoice({
      type: 'VOICE_PROCESSING',
      bubbleText: getVoiceCopy('processing'),
      errorMessage: '',
    })
    scheduleProcessingTimeout()

    try {
      await managerRef.current?.stopPressToTalk?.()
    } catch (error) {
      handleFatalVoiceError(formatVoiceError(error, '结束语音输入失败。'))
    }
  }, [clearReplyTimer, clearUiIdleTimer, getVoiceCopy, handleFatalVoiceError, scheduleProcessingTimeout])

  const handleInterrupt = useCallback(async () => {
    try {
      const result = await managerRef.current?.interruptVoiceReply?.()
      loggerRef.current.event('voice:interrupt-click', {
        accepted: result?.accepted ?? false,
      })
      clearProcessingTimer()
      clearReplyTimer()
      dispatchVoice({
        type: 'VOICE_READY',
        bubbleText: '',
        errorMessage: '',
      })
      resetUiIdleTimer()
    } catch (error) {
      handleFatalVoiceError(formatVoiceError(error, '打断当前回复失败。'))
    }
  }, [clearProcessingTimer, clearReplyTimer, handleFatalVoiceError, resetUiIdleTimer])

  const handleEnterVoiceMode = useCallback(async () => {
    if (!hasSessionRef.current) {
      setTransientBubbleForDuration(t(languageRef.current, 'signInHint'), 3200)
      return
    }

    if (!voiceSettingsRef.current.desktop_voice_enabled) {
      setTransientBubbleForDuration(`${getVoiceCopy('voiceDisabled')} ${getQuickChatEntryHint(languageRef.current)}`, 3600)
      return
    }

    if (phaseRef.current === VOICE_PHASES.LISTENING) {
      return
    }

    if (phaseRef.current === VOICE_PHASES.PROCESSING || phaseRef.current === VOICE_PHASES.REPLYING) {
      await handleInterrupt()
      return
    }

    if (phaseRef.current === VOICE_PHASES.READY || phaseRef.current === VOICE_PHASES.VOICE_ARMED) {
      resetUiIdleTimer()
      return
    }

    if (phaseRef.current === VOICE_PHASES.CONNECTING) {
      return
    }

    clearTransientBubbleTimer()
    setTransientBubble('')
    clearReplyTimer()
    clearProcessingTimer()
    loggerRef.current.event('voice:enter', {
      outputMode: voiceSettingsRef.current.desktop_voice_output_mode,
    })
    dispatchVoice({
      type: 'VOICE_ARMED',
      bubbleText: getVoiceCopy('voiceArmed'),
      errorMessage: '',
    })
    resetUiIdleTimer()

    try {
      await window.desktopBridge?.focusPetWindow?.()
      dispatchVoice({
        type: 'VOICE_CONNECTING',
        bubbleText: getVoiceCopy('connecting'),
        errorMessage: '',
      })
      await managerRef.current?.enterVoiceMode?.()
      dispatchVoice({
        type: 'VOICE_READY',
        bubbleText: getVoiceCopy('ready'),
        errorMessage: '',
      })
      resetUiIdleTimer()
    } catch (error) {
      if (isVoiceAuthError(error)) {
        loggerRef.current.event('voice:auth-expired', {
          phase: phaseRef.current,
        })
        setHasSession(false)
        hasSessionRef.current = false
        transitionToIdle()
        void managerRef.current?.shutdownVoiceSession?.({ reason: 'auth-expired' })
        setTransientBubbleForDuration(getAuthExpiredMessage(languageRef.current), AUTH_EXPIRED_BUBBLE_MS)
        return
      }
      handleFatalVoiceError(formatVoiceError(error, '语音连接失败。'))
    }
  }, [
    clearProcessingTimer,
    clearReplyTimer,
    clearTransientBubbleTimer,
    getVoiceCopy,
    handleFatalVoiceError,
    handleInterrupt,
    resetUiIdleTimer,
    setTransientBubbleForDuration,
    transitionToIdle,
  ])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onVoiceGlobalShortcut?.((payload) => {
      loggerRef.current.event('voice:global-shortcut', {
        accelerator: payload?.accelerator || '',
      })
      void handleEnterVoiceMode()
    })

    return () => {
      unsubscribe?.()
    }
  }, [handleEnterVoiceMode])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.code === 'Escape' && isVoiceUiActive(phaseRef.current)) {
        event.preventDefault()
        keyHeldRef.current = false
        transitionToIdle()
        void managerRef.current?.shutdownVoiceSession?.({ reason: 'escape' })
        return
      }

      if (event.code !== voiceSettingsRef.current.desktop_voice_trigger_key) {
        return
      }

      if (event.repeat || keyHeldRef.current || phaseRef.current !== VOICE_PHASES.READY) {
        return
      }

      event.preventDefault()
      keyHeldRef.current = true
      clearUiIdleTimer()
      clearReplyTimer()
      clearProcessingTimer()
      dispatchVoice({
        type: 'VOICE_LISTENING',
        bubbleText: getVoiceCopy('listening'),
        errorMessage: '',
      })
      void managerRef.current?.startPressToTalk?.().catch((error) => {
        handleFatalVoiceError(formatVoiceError(error, '开始语音输入失败。'))
      })
    }

    const handleKeyUp = (event) => {
      if (event.code !== voiceSettingsRef.current.desktop_voice_trigger_key) {
        return
      }

      if (!keyHeldRef.current) {
        return
      }

      event.preventDefault()
      void stopCurrentListeningTurn()
    }

    const handleBlur = () => {
      keyHeldRef.current = false
      if (phaseRef.current === VOICE_PHASES.LISTENING) {
        void stopCurrentListeningTurn()
        return
      }

      if (isVoiceUiActive(phaseRef.current)) {
        transitionToIdle()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [
    clearProcessingTimer,
    clearReplyTimer,
    clearUiIdleTimer,
    getVoiceCopy,
    handleFatalVoiceError,
    stopCurrentListeningTurn,
    transitionToIdle,
  ])

  useEffect(
    () => () => {
      if (idleBubbleTimerRef.current) {
        window.clearInterval(idleBubbleTimerRef.current)
      }
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  const schedulePositionFlush = () => {
    if (rafRef.current) {
      return
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      flushPetPosition()
    })
  }

  const flushPetPosition = ({ force = false } = {}) => {
    if (sendingPositionRef.current) {
      return flushPromiseRef.current ?? Promise.resolve(false)
    }

    if (dragRef.current.pointerId === null || (!force && !dragRef.current.moved)) {
      return Promise.resolve(false)
    }

    const sentScreenX = dragRef.current.latestScreenX
    const sentScreenY = dragRef.current.latestScreenY
    const baseScreenX = dragRef.current.baseScreenX
    const baseScreenY = dragRef.current.baseScreenY
    const baseWindowX = dragRef.current.baseWindowX
    const baseWindowY = dragRef.current.baseWindowY

    const deltaX = sentScreenX - baseScreenX
    const deltaY = sentScreenY - baseScreenY
    if (deltaX === 0 && deltaY === 0) {
      return Promise.resolve(false)
    }

    sendingPositionRef.current = true
    const requestedPosition = {
      x: baseWindowX + deltaX,
      y: baseWindowY + deltaY,
    }

    const flushPromise = window.desktopBridge
      ?.setPetPosition?.(requestedPosition)
      .then((bounds) => {
        const nextBounds = bounds?.x !== undefined && bounds?.y !== undefined ? bounds : requestedPosition
        petPositionRef.current = nextBounds
        dragRef.current.baseWindowX = nextBounds.x
        dragRef.current.baseWindowY = nextBounds.y
        dragRef.current.baseScreenX = sentScreenX
        dragRef.current.baseScreenY = sentScreenY
        return true
      })
      .catch(() => {
        dragRef.current.baseWindowX = petPositionRef.current.x ?? dragRef.current.baseWindowX
        dragRef.current.baseWindowY = petPositionRef.current.y ?? dragRef.current.baseWindowY
        dragRef.current.baseScreenX = sentScreenX
        dragRef.current.baseScreenY = sentScreenY
        return false
      })
      .finally(() => {
        sendingPositionRef.current = false
        flushPromiseRef.current = null
        if (
          !settlingPointerRef.current &&
          dragRef.current.pointerId !== null &&
          (dragRef.current.latestScreenX !== dragRef.current.baseScreenX ||
            dragRef.current.latestScreenY !== dragRef.current.baseScreenY)
        ) {
          schedulePositionFlush()
        }
      })

    flushPromiseRef.current = flushPromise
    return flushPromise
  }

  const settlePendingDrag = async () => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    while (true) {
      if (sendingPositionRef.current) {
        await (flushPromiseRef.current ?? Promise.resolve(false))
        continue
      }

      if (
        dragRef.current.latestScreenX === dragRef.current.baseScreenX &&
        dragRef.current.latestScreenY === dragRef.current.baseScreenY
      ) {
        break
      }

      await flushPetPosition({ force: true })
    }
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return
    }

    resetPetActivityTimer()
    dispatchPetAnimation({ type: 'WAKE' })
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // ignore pointer capture mismatch
    }

    dragRef.current = {
      pointerId: event.pointerId,
      thresholdScreenX: event.screenX,
      thresholdScreenY: event.screenY,
      baseScreenX: event.screenX,
      baseScreenY: event.screenY,
      latestScreenX: event.screenX,
      latestScreenY: event.screenY,
      baseWindowX: petPositionRef.current.x ?? 90,
      baseWindowY: petPositionRef.current.y ?? 90,
      moved: false,
    }
  }

  const handlePointerMove = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    dragRef.current.latestScreenX = event.screenX
    dragRef.current.latestScreenY = event.screenY

    const deltaX = event.screenX - dragRef.current.thresholdScreenX
    const deltaY = event.screenY - dragRef.current.thresholdScreenY
    if (!dragRef.current.moved && (Math.abs(deltaX) >= DRAG_THRESHOLD || Math.abs(deltaY) >= DRAG_THRESHOLD)) {
      dragRef.current.moved = true
    }

    if (dragRef.current.moved) {
      schedulePositionFlush()
    }
  }

  const finishPointerInteraction = async (event) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return
    }

    resetPetActivityTimer()
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // ignore pointer capture mismatch
    }

    dragRef.current.latestScreenX = event.screenX
    dragRef.current.latestScreenY = event.screenY

    const didMove = dragRef.current.moved
    settlingPointerRef.current = true

    if (didMove) {
      await settlePendingDrag()
    }

    dragRef.current = {
      pointerId: null,
      thresholdScreenX: 0,
      thresholdScreenY: 0,
      baseScreenX: 0,
      baseScreenY: 0,
      latestScreenX: 0,
      latestScreenY: 0,
      baseWindowX: 0,
      baseWindowY: 0,
      moved: false,
    }
    settlingPointerRef.current = false

    if (didMove) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 240)
      setTransientBubbleForDuration(t(languageRef.current, 'dragSaved'), 1500)
    }
  }

  const handleClick = () => {
    if (suppressClickRef.current) {
      return
    }
    resetPetActivityTimer()
    dispatchPetAnimation({ type: 'PET_CLICK' })
    void handleEnterVoiceMode()
  }

  const handlePetAnimationCycleComplete = useCallback(() => {
    dispatchPetAnimation({ type: 'ANIMATION_DONE' })
  }, [])

  const bubbleText = useMemo(() => {
    if (voiceUiState.phase !== VOICE_PHASES.IDLE) {
      switch (voiceUiState.phase) {
        case VOICE_PHASES.VOICE_ARMED:
          return getVoiceCopy('voiceArmed')
        case VOICE_PHASES.CONNECTING:
          return getVoiceCopy('connecting')
        case VOICE_PHASES.READY:
          return getVoiceCopy('ready')
        case VOICE_PHASES.LISTENING:
          return getVoiceCopy('listening')
        case VOICE_PHASES.PROCESSING:
          return getVoiceCopy('processing')
        case VOICE_PHASES.REPLYING:
          return voiceUiState.bubbleText || getVoiceCopy('replyingPrefix')
        case VOICE_PHASES.ERROR:
          return voiceUiState.errorMessage || getVoiceCopy('subtitleUnavailable')
        default:
          return ''
      }
    }
    return transientBubble
  }, [
    getVoiceCopy,
    transientBubble,
    voiceUiState.bubbleText,
    voiceUiState.errorMessage,
    voiceUiState.phase,
  ])

  const petMood = useMemo(() => {
    if (!hasSession) {
      return 'sad'
    }

    switch (voiceUiState.phase) {
      case VOICE_PHASES.CONNECTING:
      case VOICE_PHASES.LISTENING:
      case VOICE_PHASES.PROCESSING:
        return 'excited'
      case VOICE_PHASES.VOICE_ARMED:
      case VOICE_PHASES.READY:
      case VOICE_PHASES.REPLYING:
        return 'happy'
      case VOICE_PHASES.ERROR:
        return 'sad'
      default:
        return hovering ? 'happy' : 'idle'
    }
  }, [hasSession, hovering, voiceUiState.phase])

  const petVisual = getPetVisual(petType, petMood)
  const petLabel = t(language, petVisual.labelKey)

  return (
    <div className="pet-shell">
      <div className={`pet-scene mood-${petMood}`}>
        {bubbleText && <div className={`pet-bubble pet-bubble-${petType}`}>{bubbleText}</div>}
        <button
          type="button"
          className="pet-button"
          onClick={handleClick}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={finishPointerInteraction}
          aria-label={t(language, 'desktopPetAlt', { pet: petLabel })}
        >
          <div className="pet-button-inner">
            <PetAnimator
              petType={petType}
              action={petAnimationState.action}
              alt={t(language, 'desktopPetAlt', { pet: petLabel })}
              onCycleComplete={handlePetAnimationCycleComplete}
            />
          </div>
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<PetApp />)
