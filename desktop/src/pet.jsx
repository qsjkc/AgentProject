import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Cookie, Hand, Sparkles } from 'lucide-react'

import './desktop.css'
import { PetAnimator } from './components/PetAnimator'
import { PetOutfitRenderer } from './components/PetOutfitRenderer'
import {
  captureApiOperationContext,
  assertApiOperationContextCurrent,
  getLanguage,
  getSessionSnapshot,
  getVoiceSettings,
} from './shared/api'
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
  ANIMATION_ACTIONS,
  createInitialPetAnimationState,
  doesPetAnimationBlockCare,
  petAnimationReducer,
} from './shared/pet-animation-state'
import { getPetCareActions, getPetCareToolbarLabel } from './shared/pet-care-actions'
import {
  DEFAULT_COMPANION_SETTINGS,
  DEFAULT_COMPANION_STATE,
  evaluateCompanionOpportunity,
  normalizeCompanionSettings,
  normalizeCompanionState,
  recordCompanionCopy,
} from './shared/pet-companion'
import {
  getPetCompanionCopy,
  getPetRelationshipEventCopy,
  getPetRelationshipMilestoneCopy,
  getPetReminderCopy,
} from './shared/pet-personality'
import {
  createRewardIdempotencyKey,
  didEquippedOutfitChange,
  normalizePetRelationship,
} from './shared/pet-relationship'
import {
  createRelationshipScopedRuntimeReset,
  adoptRelationshipCapability,
  adoptPetStateCapability,
  createAuthContextChangedError,
  canCommitRelationshipReward,
  createAccountOperationGate,
  createPetAccountContextKey,
  isPetAccountContextCurrent,
  isPetAccountOperationCurrent,
  isPetRelationshipForAccountContext,
  isSessionSnapshotCurrent,
  runAccountOperation,
} from './shared/pet-account-context'
import {
  acknowledgePetRelationshipMilestone,
  claimPetRelationshipMilestone,
  getPetDailySummary,
  getPetWeeklySummary,
  markPetWeeklySummarySeen,
  markPetWeeklySummaryShown,
  refreshPetRelationship,
  rewardPetRelationship,
} from './shared/pet-relationships-api'
import {
  createPetMilestoneClaimToken,
  createPetMilestonePlaybackState,
  getPetMilestonePersistenceConflict,
  isInvalidPetMilestoneClaimError,
  isMissingPetRelationshipMilestoneError,
  isPetMilestoneClaimSafe,
  isPetMilestonePlaybackContextCurrent,
  isPetMilestonePlaybackSafe,
  isPetRelationshipReadyForMilestone,
  normalizePetMilestonePlaybackState,
  PET_MILESTONE_PLAYBACK_STATUS,
  updatePetMilestonePlaybackStatus,
} from './shared/pet-milestone-state'
import {
  canCommitPetCompanionResult,
  createPetOnboardingPresentationToken,
  deriveNextPetOnboardingStep,
  getPetOnboardingCopy,
  getPetOnboardingEngagementDelta,
  getPetOnboardingGuideCooldownUntil,
  getPetOnboardingGuideTimeoutAction,
  isPetOnboardingContextCurrent,
  isPetOnboardingGuideCoolingDown,
  isPetOnboardingSafe,
  normalizePetOnboardingStateResponse,
  PET_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_STATUS,
  PET_ONBOARDING_STEPS,
  shouldRecordPetOnboardingInteraction,
} from './shared/pet-onboarding-state'
import { PET_ONBOARDING_MAIN_PANEL_INTENT } from './shared/pet-onboarding-main'
import { getPetVisual } from './shared/pets'
import { getPendingReminders, markReminderTriggered } from './shared/reminders-api'

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
const COMPANION_POLL_INTERVAL_MS = 30000
const MILESTONE_POLL_INTERVAL_MS = 15000
const ONBOARDING_POLL_INTERVAL_MS = 1000
const ONBOARDING_GUIDE_DURATION_MS = Object.freeze({
  [PET_ONBOARDING_STEPS.MEET_PET]: 6000,
  [PET_ONBOARDING_STEPS.RELATIONSHIP]: 8000,
})

const CARE_ACTION_ICONS = {
  pat: Hand,
  feed: Cookie,
  clean: Sparkles,
}

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

function createExpectedPetAccountContext({
  userId,
  relationshipId = null,
  petType = 'pig',
  session = null,
  authoritative = null,
} = {}) {
  return {
    hasSession: true,
    userId,
    relationshipId,
    petType,
    session,
    authoritative,
  }
}

function PetApp() {
  const [petType, setPetType] = useState('cat')
  const [language, setLanguageState] = useState('zh-CN')
  const [hasSession, setHasSession] = useState(false)
  const [userId, setUserId] = useState(null)
  const [sessionSnapshot, setSessionSnapshotState] = useState(null)
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES)
  const [voiceSettings, setVoiceSettings] = useState(DEFAULT_VOICE_SETTINGS)
  const [companionSettings, setCompanionSettings] = useState(DEFAULT_COMPANION_SETTINGS)
  const [transientBubble, setTransientBubble] = useState('')
  const [intimacyFeedback, setIntimacyFeedback] = useState('')
  const [activeCareAction, setActiveCareAction] = useState('')
  const [petRelationship, setPetRelationship] = useState(null)
  const [milestonePlayback, setMilestonePlayback] = useState(null)
  const [onboardingState, setOnboardingState] = useState(null)
  const [onboardingStateLoaded, setOnboardingStateLoaded] = useState(false)
  const [onboardingGuide, setOnboardingGuide] = useState(null)
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
  const intimacyFeedbackTimerRef = useRef(null)
  const idleBubbleTimerRef = useRef(null)
  const uiIdleTimerRef = useRef(null)
  const processingTimerRef = useRef(null)
  const replyTimerRef = useRef(null)
  const sleepTimerRef = useRef(null)
  const milestonePumpTimerRef = useRef(null)
  const onboardingPumpTimerRef = useRef(null)
  const onboardingGuideTimerRef = useRef(null)
  const onboardingEngagementTickRef = useRef(null)
  const onboardingEngagementInFlightRef = useRef(false)
  const previousSessionRef = useRef(null)
  const voiceIntroPendingRef = useRef(true)
  const previousPhaseRef = useRef(VOICE_PHASES.IDLE)
  const phaseRef = useRef(VOICE_PHASES.IDLE)
  const transientBubbleRef = useRef(transientBubble)
  const languageRef = useRef(language)
  const petTypeRef = useRef(petType)
  const voiceSettingsRef = useRef(voiceSettings)
  const hasSessionRef = useRef(hasSession)
  const userIdRef = useRef(userId)
  const sessionSnapshotRef = useRef(null)
  const authoritativeContextRef = useRef(null)
  const sessionSyncEpochRef = useRef(0)
  const relationshipRef = useRef(null)
  const milestonePlaybackRef = useRef(null)
  const milestonePlaybackLoadedRef = useRef(false)
  const milestoneRequestInFlightRef = useRef(null)
  const milestoneContextEpochRef = useRef(0)
  const milestoneAccountContextKeyRef = useRef(null)
  const milestonePumpRef = useRef(null)
  const onboardingStateRef = useRef(null)
  const onboardingStateLoadedRef = useRef(false)
  const onboardingGuideRef = useRef(null)
  const onboardingGuideCompletionInFlightRef = useRef(null)
  const onboardingRequestInFlightRef = useRef(null)
  const onboardingContextEpochRef = useRef(0)
  const onboardingGuideCooldownRef = useRef({})
  const onboardingPumpRef = useRef(null)
  const interruptOnboardingGuideRef = useRef(null)
  const relationshipLoadEpochRef = useRef(0)
  const reminderPollRef = useRef(null)
  const companionSettingsRef = useRef(DEFAULT_COMPANION_SETTINGS)
  const companionStateRef = useRef(DEFAULT_COMPANION_STATE)
  const companionStateReadyRef = useRef(false)
  const companionRequestInFlightRef = useRef(null)
  const companionLoadGateRef = useRef(null)
  if (!companionLoadGateRef.current) companionLoadGateRef.current = createAccountOperationGate()
  const petAnimationStateRef = useRef(petAnimationState)
  const activeCareActionRef = useRef('')
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
    wokeFromSleep: false,
  })

  const clearTransientBubbleTimer = useCallback(() => {
    if (transientBubbleTimerRef.current) {
      window.clearTimeout(transientBubbleTimerRef.current)
      transientBubbleTimerRef.current = null
    }
  }, [])

  const showIntimacyFeedback = useCallback((text) => {
    if (intimacyFeedbackTimerRef.current) {
      window.clearTimeout(intimacyFeedbackTimerRef.current)
    }
    setIntimacyFeedback(text)
    intimacyFeedbackTimerRef.current = window.setTimeout(() => {
      setIntimacyFeedback('')
      intimacyFeedbackTimerRef.current = null
    }, 1800)
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
        !settlingPointerRef.current &&
        !onboardingGuideRef.current &&
        !onboardingRequestInFlightRef.current
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

  const getCurrentPetAccountContext = useCallback(() => ({
    hasSession: hasSessionRef.current,
    userId: userIdRef.current,
    petType: petTypeRef.current,
    session: sessionSnapshotRef.current,
    authoritative: authoritativeContextRef.current,
    relationshipId: relationshipRef.current?.id ?? null,
  }), [])

  const capturePetApiOperation = useCallback(async (expectedContext = null, scope = 'pet') => {
    const initiatingContext = expectedContext || getCurrentPetAccountContext()
    const operationContext = await captureApiOperationContext(initiatingContext, scope)
    if (
      !operationContext
      || !isPetAccountOperationCurrent(initiatingContext, getCurrentPetAccountContext())
    ) {
      throw createAuthContextChangedError()
    }
    if (!sessionSnapshotRef.current && operationContext.session) {
      sessionSnapshotRef.current = operationContext.session
      setSessionSnapshotState(operationContext.session)
    }
    authoritativeContextRef.current = operationContext.authoritative
    return operationContext
  }, [getCurrentPetAccountContext])

  const isMilestoneContextCurrent = useCallback((epoch) => (
    isPetMilestonePlaybackContextCurrent({
      expectedEpoch: epoch,
      currentEpoch: milestoneContextEpochRef.current,
      petType: petTypeRef.current,
      hasSession: hasSessionRef.current,
    })
    && milestoneAccountContextKeyRef.current !== null
    && milestoneAccountContextKeyRef.current === createPetAccountContextKey(
      getCurrentPetAccountContext(),
    )
  ), [getCurrentPetAccountContext])

  const replaceMilestoneRuntimeState = useCallback((value) => {
    const nextPlayback = normalizePetMilestonePlaybackState(value, 'pig')
    milestonePlaybackRef.current = nextPlayback
    setMilestonePlayback(nextPlayback)
    return nextPlayback
  }, [])

  const persistMilestonePlaybackState = useCallback(async (
    value,
    epoch = milestoneContextEpochRef.current,
    expectedContext = null,
  ) => {
    const capturedContext = expectedContext || getCurrentPetAccountContext()
    const nextPlayback = normalizePetMilestonePlaybackState(value, 'pig')
    if (!nextPlayback || !window.desktopBridge?.setPetMilestonePlayback) {
      throw new Error('pet_milestone_persistence_unavailable')
    }
    const response = await window.desktopBridge.setPetMilestonePlayback(
      'pig',
      nextPlayback,
      nextPlayback.revision,
      createExpectedPetAccountContext(capturedContext),
    )
    if (!isPetAccountOperationCurrent(capturedContext, getCurrentPetAccountContext())) {
      throw createAuthContextChangedError()
    }
    if (!response?.ok) {
      const conflict = getPetMilestonePersistenceConflict(response, 'pig')
      if (conflict && isMilestoneContextCurrent(epoch)) {
        replaceMilestoneRuntimeState(conflict.current)
      }
      const error = new Error(response?.reason || 'pet_milestone_persistence_failed')
      error.code = conflict
        ? 'PET_MILESTONE_PERSISTENCE_CONFLICT'
        : 'PET_MILESTONE_PERSISTENCE_UNAVAILABLE'
      error.current = conflict?.current || null
      throw error
    }
    const stored = normalizePetMilestonePlaybackState(response.playback, 'pig')
    if (
      !stored
      || stored.claim_token !== nextPlayback.claim_token
      || stored.revision !== nextPlayback.revision + 1
    ) {
      throw new Error('pet_milestone_persistence_failed')
    }
    return stored
  }, [getCurrentPetAccountContext, isMilestoneContextCurrent, replaceMilestoneRuntimeState])

  const clearMilestonePlaybackState = useCallback(async (
    claimToken,
    expectedRevision,
    epoch = milestoneContextEpochRef.current,
    expectedContext = null,
  ) => {
    const capturedContext = expectedContext || getCurrentPetAccountContext()
    if (!window.desktopBridge?.clearPetMilestonePlayback) {
      throw new Error('pet_milestone_persistence_unavailable')
    }
    const response = await window.desktopBridge.clearPetMilestonePlayback(
      'pig',
      claimToken,
      expectedRevision,
      createExpectedPetAccountContext(capturedContext),
    )
    if (!isPetAccountOperationCurrent(capturedContext, getCurrentPetAccountContext())) {
      throw createAuthContextChangedError()
    }
    if (!response?.ok) {
      const conflict = getPetMilestonePersistenceConflict(response, 'pig')
      if (conflict && isMilestoneContextCurrent(epoch)) {
        replaceMilestoneRuntimeState(conflict.current)
      }
      const error = new Error(response?.reason || 'pet_milestone_clear_failed')
      error.code = conflict
        ? 'PET_MILESTONE_PERSISTENCE_CONFLICT'
        : 'PET_MILESTONE_PERSISTENCE_UNAVAILABLE'
      error.current = conflict?.current || null
      throw error
    }
    if (
      isMilestoneContextCurrent(epoch)
      && milestonePlaybackRef.current?.claim_token === claimToken
    ) {
      replaceMilestoneRuntimeState(null)
    }
  }, [getCurrentPetAccountContext, isMilestoneContextCurrent, replaceMilestoneRuntimeState])

  const getMilestonePlaybackContext = useCallback((milestone = null) => ({
    petType: petTypeRef.current,
    hasSession: hasSessionRef.current,
    visibilityState: document.visibilityState,
    voicePhase: phaseRef.current,
    pointerActive: dragRef.current.pointerId !== null,
    settlingPointer: settlingPointerRef.current,
    activeCareAction: activeCareActionRef.current,
    transientBubble: transientBubbleRef.current,
    animationState: petAnimationStateRef.current,
    relationship: relationshipRef.current,
    milestone,
  }), [])

  const interruptMilestonePlayback = useCallback(
    async (reason) => {
      const epoch = milestoneContextEpochRef.current
      const current = milestonePlaybackRef.current
      if (
        current?.status !== PET_MILESTONE_PLAYBACK_STATUS.PLAYING
        || !current.milestone
      ) {
        return false
      }

      const queued = updatePetMilestonePlaybackStatus(
        current,
        PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
      )
      replaceMilestoneRuntimeState(queued)
      clearTransientBubbleTimer()
      setTransientBubble('')
      transientBubbleRef.current = ''
      dispatchPetAnimation({
        type: 'MILESTONE_INTERRUPTED',
        milestoneId: current.milestone.id,
      })
      loggerRef.current.event('milestone:interrupted', {
        milestoneId: current.milestone.id,
        reason,
      })
      try {
        const operationContext = await capturePetApiOperation(
          { ...getCurrentPetAccountContext(), relationshipId: relationshipRef.current?.id },
          'relationship',
        )
        const storedQueued = await persistMilestonePlaybackState(queued, epoch, operationContext)
        if (!isMilestoneContextCurrent(epoch)) {
          return false
        }
        replaceMilestoneRuntimeState(storedQueued)
      } catch (error) {
        loggerRef.current.error('milestone:interrupt-persist-failed', error, {
          milestoneId: current.milestone.id,
          reason,
        })
      }
      return true
    },
    [
      clearTransientBubbleTimer,
      isMilestoneContextCurrent,
      persistMilestonePlaybackState,
      replaceMilestoneRuntimeState,
    ],
  )

  const acknowledgeMilestonePlayback = useCallback(
    async (playback, epoch = milestoneContextEpochRef.current, providedOperationContext = null) => {
      const milestone = playback?.milestone
      if (!milestone || !isMilestoneContextCurrent(epoch)) {
        return false
      }

      let operationContext = providedOperationContext
      try {
        operationContext = operationContext
          || await capturePetApiOperation(
            { ...getCurrentPetAccountContext(), relationshipId: relationshipRef.current?.id },
            'relationship',
          )
        if (!isMilestoneContextCurrent(epoch)) {
          return false
        }
        await acknowledgePetRelationshipMilestone(
          'pig',
          milestone.id,
          playback.claim_token,
          operationContext,
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return false
        }
        await clearMilestonePlaybackState(
          playback.claim_token,
          playback.revision,
          epoch,
          operationContext,
        )
        loggerRef.current.event('milestone:acknowledged', {
          milestoneId: milestone.id,
        })
        return true
      } catch (error) {
        if (isMissingPetRelationshipMilestoneError(error)) {
          loggerRef.current.error('milestone:ack-not-found', error, {
            milestoneId: milestone.id,
          })
          if (!isMilestoneContextCurrent(epoch)) {
            return false
          }
          try {
            await clearMilestonePlaybackState(
              playback.claim_token,
              playback.revision,
              epoch,
              operationContext,
            )
          } catch (clearError) {
            loggerRef.current.error('milestone:ack-not-found-clear-failed', clearError, {
              milestoneId: milestone.id,
            })
          }
          return false
        }

        if (isInvalidPetMilestoneClaimError(error)) {
          loggerRef.current.error('milestone:ack-claim-invalid', error, {
            milestoneId: milestone.id,
          })
          if (!isMilestoneContextCurrent(epoch)) {
            return false
          }
          const reconcileToken = createPetMilestoneClaimToken()
          const reconcileState = createPetMilestonePlaybackState({
            petType: 'pig',
            status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
            claimToken: reconcileToken,
            milestone: {
              ...milestone,
              claim_token: reconcileToken,
              claim_expires_at: null,
            },
            displayed: true,
            revision: playback.revision,
          })
          try {
            const storedReconcile = await persistMilestonePlaybackState(
              reconcileState,
              epoch,
              operationContext,
            )
            if (!isMilestoneContextCurrent(epoch)) {
              return false
            }
            replaceMilestoneRuntimeState(storedReconcile)
          } catch (persistError) {
            loggerRef.current.error('milestone:ack-reconcile-persist-failed', persistError, {
              milestoneId: milestone.id,
            })
          }
          return false
        }

        loggerRef.current.error('milestone:ack-failed', error, {
          milestoneId: milestone.id,
        })
        return false
      }
    },
    [
      clearMilestonePlaybackState,
      capturePetApiOperation,
      getCurrentPetAccountContext,
      isMilestoneContextCurrent,
      persistMilestonePlaybackState,
      replaceMilestoneRuntimeState,
    ],
  )

  const runMilestonePump = useCallback(async () => {
    const epoch = milestoneContextEpochRef.current
    if (
      milestoneRequestInFlightRef.current?.epoch === epoch
      || !milestonePlaybackLoadedRef.current
      || !isMilestoneContextCurrent(epoch)
    ) {
      return
    }

    const activePlayback = milestonePlaybackRef.current
    if (activePlayback?.status === PET_MILESTONE_PLAYBACK_STATUS.PLAYING) {
      return
    }

    const requestKey = { epoch }
    milestoneRequestInFlightRef.current = requestKey
    try {
      let operationContext = await capturePetApiOperation(
        { ...getCurrentPetAccountContext(), relationshipId: relationshipRef.current?.id },
        'relationship',
      )
      if (!isMilestoneContextCurrent(epoch)) {
        return
      }
      if (activePlayback?.status === PET_MILESTONE_PLAYBACK_STATUS.ACK_PENDING) {
        const storedAckPending = await persistMilestonePlaybackState(
          activePlayback,
          epoch,
          operationContext,
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return
        }
        replaceMilestoneRuntimeState(storedAckPending)
        await acknowledgeMilestonePlayback(storedAckPending, epoch, operationContext)
        return
      }

      if (!isPetMilestoneClaimSafe(getMilestonePlaybackContext())) {
        return
      }

      let claimState = activePlayback
      if (!claimState) {
        claimState = createPetMilestonePlaybackState({
          petType: 'pig',
          status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
          claimToken: createPetMilestoneClaimToken(),
        })
        const storedClaim = await persistMilestonePlaybackState(
          claimState,
          epoch,
          operationContext,
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return
        }
        claimState = replaceMilestoneRuntimeState(storedClaim)
      }

      if (
        !isMilestoneContextCurrent(epoch)
        || !isPetMilestoneClaimSafe(getMilestonePlaybackContext())
      ) {
        return
      }

      const milestone = await claimPetRelationshipMilestone(
        'pig',
        claimState.claim_token,
        operationContext,
      )
      if (!isMilestoneContextCurrent(epoch)) {
        return
      }
      if (!milestone) {
        if (claimState.displayed && claimState.milestone) {
          loggerRef.current.event('milestone:reconcile-waiting', {
            milestoneId: claimState.milestone.id,
          })
          return
        }
        await clearMilestonePlaybackState(
          claimState.claim_token,
          claimState.revision,
          epoch,
          operationContext,
        )
        return
      }
      if (milestone.claim_token !== claimState.claim_token) {
        return
      }
      await interruptOnboardingGuideRef.current?.('milestone')
      if (!isMilestoneContextCurrent(epoch)) {
        return
      }
      if (milestone.acknowledged_at) {
        await clearMilestonePlaybackState(
          claimState.claim_token,
          claimState.revision,
          epoch,
          operationContext,
        )
        return
      }

      if (claimState.displayed && claimState.milestone) {
        if (milestone.id === claimState.milestone.id) {
          const reconciledAckPending = createPetMilestonePlaybackState({
            petType: 'pig',
            status: PET_MILESTONE_PLAYBACK_STATUS.ACK_PENDING,
            claimToken: claimState.claim_token,
            milestone,
            displayed: true,
            revision: claimState.revision,
          })
          const storedReconciledAck = await persistMilestonePlaybackState(
            reconciledAckPending,
            epoch,
            operationContext,
          )
          if (!isMilestoneContextCurrent(epoch)) {
            return
          }
          replaceMilestoneRuntimeState(storedReconciledAck)
          await acknowledgeMilestonePlayback(storedReconciledAck, epoch, operationContext)
          return
        }
        loggerRef.current.event('milestone:reconcile-advanced', {
          previousMilestoneId: claimState.milestone.id,
          nextMilestoneId: milestone.id,
        })
      }

      const queued = createPetMilestonePlaybackState({
        petType: 'pig',
        status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
        claimToken: claimState.claim_token,
        milestone,
        displayed: false,
        revision: claimState.revision,
      })
      const storedQueued = await persistMilestonePlaybackState(queued, epoch, operationContext)
      if (!isMilestoneContextCurrent(epoch)) {
        return
      }
      replaceMilestoneRuntimeState(storedQueued)

      if (!isPetRelationshipReadyForMilestone(relationshipRef.current, milestone)) {
        try {
          const refreshedRelationship = await refreshPetRelationship('pig', operationContext)
          if (!isMilestoneContextCurrent(epoch)) {
            return
          }
          const nextCapability = refreshedRelationship?.__operation_authoritative
          if (
            !nextCapability
            || Number(refreshedRelationship?.id) !== Number(operationContext.relationshipId)
            || Number(refreshedRelationship?.user_id) !== Number(operationContext.userId)
            || refreshedRelationship?.pet_type !== operationContext.petType
          ) {
            return
          }
          operationContext = { ...operationContext, authoritative: nextCapability }
          authoritativeContextRef.current = nextCapability
          relationshipRef.current = refreshedRelationship
          setPetRelationship(refreshedRelationship)
        } catch (error) {
          if (!isMilestoneContextCurrent(epoch)) {
            return
          }
          loggerRef.current.error('milestone:relationship-refresh-failed', error, {
            milestoneId: milestone.id,
          })
        }
        if (!isPetRelationshipReadyForMilestone(relationshipRef.current, milestone)) {
          await clearMilestonePlaybackState(
            storedQueued.claim_token,
            storedQueued.revision,
            epoch,
            operationContext,
          )
          loggerRef.current.event('milestone:relationship-not-ready', {
            milestoneId: milestone.id,
            relationshipLevel: relationshipRef.current?.level,
          })
          return
        }
      }

      const playbackContext = getMilestonePlaybackContext(milestone)
      if (!isPetMilestonePlaybackSafe(playbackContext)) {
        return
      }

      const playing = updatePetMilestonePlaybackStatus(
        storedQueued,
        PET_MILESTONE_PLAYBACK_STATUS.PLAYING,
      )
      const storedPlaying = await persistMilestonePlaybackState(playing, epoch, operationContext)
      if (!isMilestoneContextCurrent(epoch)) {
        return
      }
      if (!isPetMilestonePlaybackSafe(getMilestonePlaybackContext(milestone))) {
        const restoredClaim = updatePetMilestonePlaybackStatus(
          storedPlaying,
          PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
        )
        const storedRestoredClaim = await persistMilestonePlaybackState(
          restoredClaim,
          epoch,
          operationContext,
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return
        }
        replaceMilestoneRuntimeState(storedRestoredClaim)
        return
      }

      replaceMilestoneRuntimeState(storedPlaying)
      const message = getPetRelationshipMilestoneCopy(
        'pig',
        languageRef.current,
        milestone,
      )
      setTransientBubbleForDuration(message, 3600)
      dispatchPetAnimation({
        type: 'LEVEL_UP',
        message,
        milestoneId: milestone.id,
      })
      loggerRef.current.event('milestone:playing', {
        milestoneId: milestone.id,
        level: milestone.level,
        rewardOutfitId: milestone.reward_outfit_id,
      })
    } catch (error) {
      loggerRef.current.error('milestone:pump-failed', error)
    } finally {
      if (milestoneRequestInFlightRef.current === requestKey) {
        milestoneRequestInFlightRef.current = null
      }
    }
  }, [
    acknowledgeMilestonePlayback,
    capturePetApiOperation,
    clearMilestonePlaybackState,
    getMilestonePlaybackContext,
    isMilestoneContextCurrent,
    persistMilestonePlaybackState,
    replaceMilestoneRuntimeState,
    setTransientBubbleForDuration,
  ])

  milestonePumpRef.current = runMilestonePump

  const clearOnboardingGuideRuntime = useCallback((stepId, token) => {
    const current = onboardingGuideRef.current
    if (
      !current
      || (stepId && current.stepId !== stepId)
      || (token && current.token !== token)
    ) {
      return null
    }
    if (onboardingGuideTimerRef.current) {
      window.clearTimeout(onboardingGuideTimerRef.current)
      onboardingGuideTimerRef.current = null
    }
    onboardingGuideRef.current = null
    setOnboardingGuide(null)
    return current
  }, [])

  const isOnboardingContextCurrent = useCallback((context) => (
    isPetOnboardingContextCurrent({
      expectedEpoch: context?.epoch,
      currentEpoch: onboardingContextEpochRef.current,
      expectedUserId: context?.userId,
      currentUserId: userIdRef.current,
      expectedRelationshipId: context?.relationshipId,
      currentRelationshipId: relationshipRef.current?.id,
      petType: petTypeRef.current,
      hasSession: hasSessionRef.current,
    })
    && isSessionSnapshotCurrent(context?.session, sessionSnapshotRef.current)
  ), [])

  const replaceOnboardingRuntimeState = useCallback((value, context = null) => {
    const nextState = normalizePetOnboardingStateResponse(value)
    if (context && !isOnboardingContextCurrent(context)) {
      return onboardingStateRef.current
    }
    const current = onboardingStateRef.current
    if (
      nextState
      && current
      && nextState.user_id === current.user_id
      && nextState.relationship_id === current.relationship_id
      && nextState.revision < current.revision
    ) {
      return current
    }
    onboardingStateRef.current = nextState
    setOnboardingState(nextState)
    const guide = onboardingGuideRef.current
    if (
      guide
      && (
        !nextState
        || nextState.presentation?.step_id !== guide.stepId
        || nextState.presentation?.token !== guide.token
      )
    ) {
      clearOnboardingGuideRuntime(guide.stepId, guide.token)
    }
    return nextState
  }, [clearOnboardingGuideRuntime, isOnboardingContextCurrent])

  const getOnboardingContext = useCallback(() => ({
    epoch: onboardingContextEpochRef.current,
    userId: userIdRef.current,
    relationshipId: relationshipRef.current?.id,
    petType: petTypeRef.current,
    session: sessionSnapshotRef.current,
    authoritative: authoritativeContextRef.current,
  }), [])

  const refreshOnboardingRuntimeState = useCallback(async (context) => {
    if (!isOnboardingContextCurrent(context)) {
      return null
    }
    try {
      const state = await window.desktopBridge?.getPetOnboardingState?.(
        'pig',
        createExpectedPetAccountContext(context),
      )
      if (!isOnboardingContextCurrent(context)) {
        return null
      }
      return replaceOnboardingRuntimeState(state, context)
    } catch (error) {
      loggerRef.current.error('onboarding:state-refresh-failed', error)
      return null
    }
  }, [isOnboardingContextCurrent, replaceOnboardingRuntimeState])

  const applyOnboardingMutationResponse = useCallback((response, context) => {
    if (!isOnboardingContextCurrent(context)) {
      return null
    }
    if (response?.ok === false) {
      void refreshOnboardingRuntimeState(context)
      return null
    }
    const state = normalizePetOnboardingStateResponse(response)
    if (state) {
      return replaceOnboardingRuntimeState(state, context)
    }
    return null
  }, [
    isOnboardingContextCurrent,
    refreshOnboardingRuntimeState,
    replaceOnboardingRuntimeState,
  ])

  const setOnboardingGuideCooldown = useCallback((stepId, reason) => {
    const cooldownUntil = getPetOnboardingGuideCooldownUntil({
      stepId,
      reason,
      nowMs: window.performance.now(),
    })
    if (cooldownUntil !== null) {
      onboardingGuideCooldownRef.current[stepId] = cooldownUntil
    }
  }, [])

  const interruptOnboardingGuide = useCallback(async (reason) => {
    const activeGuide = onboardingGuideRef.current
    if (activeGuide) {
      setOnboardingGuideCooldown(activeGuide.stepId, reason)
    }
    const guide = clearOnboardingGuideRuntime()
    if (!guide) {
      return false
    }
    loggerRef.current.event('onboarding:interrupted', {
      stepId: guide.stepId,
      reason,
    })
    try {
      const response = await window.desktopBridge?.releasePetOnboardingPresentation?.(
        'pig',
        guide.stepId,
        guide.token,
        createExpectedPetAccountContext(guide.context),
      )
      applyOnboardingMutationResponse(response, guide.context)
    } catch (error) {
      loggerRef.current.error('onboarding:release-failed', error, {
        stepId: guide.stepId,
        reason,
      })
    } finally {
      void onboardingPumpRef.current?.()
    }
    return true
  }, [applyOnboardingMutationResponse, clearOnboardingGuideRuntime, setOnboardingGuideCooldown])

  interruptOnboardingGuideRef.current = interruptOnboardingGuide

  const completeOnboardingGuide = useCallback(async (
    stepId,
    token,
    { openRelationship = false } = {},
  ) => {
    const current = onboardingGuideRef.current
    if (!current || current.stepId !== stepId || current.token !== token) {
      return false
    }
    const completionKey = `${stepId}:${token}`
    if (onboardingGuideCompletionInFlightRef.current) {
      return false
    }
    onboardingGuideCompletionInFlightRef.current = completionKey
    try {
      if (openRelationship && stepId === PET_ONBOARDING_STEPS.RELATIONSHIP) {
        const intentOperation = await capturePetApiOperation(current.context, 'relationship')
        const opened = await window.desktopBridge?.openMainPanel?.({
          intent: PET_ONBOARDING_MAIN_PANEL_INTENT,
          expectedContext: intentOperation.authoritative,
        })
        if (opened !== true) {
          loggerRef.current.event('onboarding:relationship-open-rejected', { stepId })
          if (onboardingGuideRef.current === current && isOnboardingContextCurrent(current.context)) {
            await interruptOnboardingGuide('lease-rejected')
          }
          return false
        }
        if (
          onboardingGuideRef.current?.stepId !== stepId
          || onboardingGuideRef.current?.token !== token
          || !isOnboardingContextCurrent(current.context)
        ) {
          return false
        }
      }

      const renewalResponse = await window.desktopBridge?.claimPetOnboardingPresentation?.(
        'pig',
        stepId,
        token,
        createExpectedPetAccountContext(current.context),
      )
      if (!isOnboardingContextCurrent(current.context)) {
        return false
      }
      const renewedState = applyOnboardingMutationResponse(renewalResponse, current.context)
      if (
        !renewalResponse?.ok
        || !renewedState
        || renewedState.presentation?.step_id !== stepId
        || renewedState.presentation?.token !== token
      ) {
        clearOnboardingGuideRuntime(stepId, token)
        setOnboardingGuideCooldown(stepId, 'lease-rejected')
        void window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          stepId,
          token,
          createExpectedPetAccountContext(current.context),
        )
        loggerRef.current.event('onboarding:lease-renewal-rejected', {
          stepId,
          reason: renewalResponse?.reason || 'bridge-unavailable',
        })
        return false
      }

      if (
        onboardingGuideRef.current?.stepId !== stepId
        || onboardingGuideRef.current?.token !== token
        || !isOnboardingContextCurrent(current.context)
      ) {
        void window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          stepId,
          token,
          createExpectedPetAccountContext(current.context),
        )
        return false
      }

      const response = await window.desktopBridge?.ackPetOnboardingPresentation?.(
        'pig',
        stepId,
        token,
        createExpectedPetAccountContext(current.context),
      )
      if (!isOnboardingContextCurrent(current.context)) {
        return false
      }
      const nextState = applyOnboardingMutationResponse(response, current.context)
      if (!response?.ok || !nextState) {
        clearOnboardingGuideRuntime(stepId, token)
        setOnboardingGuideCooldown(stepId, 'lease-rejected')
        void window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          stepId,
          token,
          createExpectedPetAccountContext(current.context),
        )
        loggerRef.current.event('onboarding:ack-rejected', {
          stepId,
          reason: response?.reason || 'bridge-unavailable',
        })
        return false
      }
      clearOnboardingGuideRuntime(stepId, token)
      loggerRef.current.event('onboarding:shown', { stepId })
      void onboardingPumpRef.current?.()
      return true
    } catch (error) {
      loggerRef.current.error('onboarding:ack-failed', error, { stepId })
      if (onboardingGuideRef.current === current && isOnboardingContextCurrent(current.context)) {
        clearOnboardingGuideRuntime(stepId, token)
        setOnboardingGuideCooldown(stepId, 'lease-rejected')
        void window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          stepId,
          token,
          createExpectedPetAccountContext(current.context),
        )
      }
      return false
    } finally {
      if (onboardingGuideCompletionInFlightRef.current === completionKey) {
        onboardingGuideCompletionInFlightRef.current = null
      }
    }
  }, [
    applyOnboardingMutationResponse,
    capturePetApiOperation,
    clearOnboardingGuideRuntime,
    interruptOnboardingGuide,
    isOnboardingContextCurrent,
    setOnboardingGuideCooldown,
  ])

  const clearRelationshipScopedRuntime = useCallback((reason) => {
    const reset = createRelationshipScopedRuntimeReset({
      milestoneId: petAnimationStateRef.current.milestoneId,
    })
    relationshipLoadEpochRef.current += 1
    relationshipRef.current = null
    setPetRelationship(null)

    companionRequestInFlightRef.current = null
    companionStateRef.current = DEFAULT_COMPANION_STATE
    companionStateReadyRef.current = false

    milestoneContextEpochRef.current += 1
    milestoneAccountContextKeyRef.current = null
    milestonePlaybackLoadedRef.current = false
    milestoneRequestInFlightRef.current = null
    replaceMilestoneRuntimeState(null)

    onboardingContextEpochRef.current += 1
    onboardingGuideCooldownRef.current = {}
    onboardingStateLoadedRef.current = false
    onboardingRequestInFlightRef.current = null
    onboardingGuideCompletionInFlightRef.current = null
    setOnboardingStateLoaded(false)
    const guide = clearOnboardingGuideRuntime()
    if (guide) {
      void window.desktopBridge?.releasePetOnboardingPresentation?.(
        'pig',
        guide.stepId,
        guide.token,
        createExpectedPetAccountContext(guide.context),
      )
    }
    replaceOnboardingRuntimeState(null)

    if (intimacyFeedbackTimerRef.current) {
      window.clearTimeout(intimacyFeedbackTimerRef.current)
      intimacyFeedbackTimerRef.current = null
    }
    setIntimacyFeedback('')
    activeCareActionRef.current = ''
    setActiveCareAction('')
    clearTransientBubbleTimer()
    transientBubbleRef.current = ''
    setTransientBubble('')
    dispatchPetAnimation(reset.animationCompletion)
    loggerRef.current.event('relationship:runtime-cleared', { reason })
  }, [
    clearOnboardingGuideRuntime,
    clearTransientBubbleTimer,
    replaceMilestoneRuntimeState,
    replaceOnboardingRuntimeState,
  ])

  const recordOnboardingInteraction = useCallback(async (source) => {
    const context = getOnboardingContext()
    if (!shouldRecordPetOnboardingInteraction({
      loaded: onboardingStateLoadedRef.current,
      state: onboardingStateRef.current,
    })) {
      return false
    }
    await interruptOnboardingGuide('pet-interaction')
    if (
      !isOnboardingContextCurrent(context)
      || !shouldRecordPetOnboardingInteraction({
        loaded: onboardingStateLoadedRef.current,
        state: onboardingStateRef.current,
      })
    ) {
      return false
    }
    try {
      const response = await window.desktopBridge?.recordPetOnboardingObservation?.(
        'pig',
        PET_ONBOARDING_CAPABILITIES.PET_INTERACTION,
        { source },
        createExpectedPetAccountContext(context),
      )
      applyOnboardingMutationResponse(response, context)
      void onboardingPumpRef.current?.()
      return Boolean(response?.ok)
    } catch (error) {
      loggerRef.current.error('onboarding:interaction-failed', error, { source })
      return false
    }
  }, [
    applyOnboardingMutationResponse,
    getOnboardingContext,
    interruptOnboardingGuide,
    isOnboardingContextCurrent,
  ])

  const runOnboardingPump = useCallback(async () => {
    const context = getOnboardingContext()
    if (
      onboardingRequestInFlightRef.current
      || !onboardingStateLoadedRef.current
      || !isOnboardingContextCurrent(context)
      || onboardingGuideRef.current
    ) {
      return
    }
    const stepId = deriveNextPetOnboardingStep(onboardingStateRef.current)
    if (!stepId) {
      return
    }
    if (isPetOnboardingGuideCoolingDown(
      onboardingGuideCooldownRef.current[stepId],
      window.performance.now(),
    )) {
      return
    }
    const requestKey = { ...context, type: 'claim', stepId }
    onboardingRequestInFlightRef.current = requestKey
    try {
      const idleSeconds = await window.desktopBridge?.getSystemIdleSeconds?.()
      if (
        !isOnboardingContextCurrent(context)
        || !isPetOnboardingSafe({
          petType: petTypeRef.current,
          hasSession: hasSessionRef.current,
          userId: userIdRef.current,
          relationship: relationshipRef.current,
          visibilityState: document.visibilityState,
          systemIdleSeconds: idleSeconds,
          voicePhase: phaseRef.current,
          pointerActive: dragRef.current.pointerId !== null,
          settlingPointer: settlingPointerRef.current,
          activeCareAction: activeCareActionRef.current,
          transientBubble: transientBubbleRef.current,
          animationState: petAnimationStateRef.current,
          milestonePlayback: milestonePlaybackRef.current,
          milestoneRequestInFlight: milestoneRequestInFlightRef.current,
          companionRequestInFlight: companionRequestInFlightRef.current,
          onboardingState: onboardingStateRef.current,
          activeGuide: onboardingGuideRef.current,
        })
      ) {
        return
      }

      const existingPresentation = onboardingStateRef.current?.presentation
      const token = existingPresentation?.step_id === stepId
        ? existingPresentation.token
        : createPetOnboardingPresentationToken()
      const response = await window.desktopBridge?.claimPetOnboardingPresentation?.(
        'pig',
        stepId,
        token,
        createExpectedPetAccountContext(context),
      )
      const claimedState = applyOnboardingMutationResponse(response, context)
      if (
        !response?.ok
        || !claimedState
        || claimedState.presentation?.step_id !== stepId
        || claimedState.presentation?.token !== token
        || !isOnboardingContextCurrent(context)
      ) {
        return
      }

      const postClaimIdleSeconds = await window.desktopBridge?.getSystemIdleSeconds?.()
      if (
        !isOnboardingContextCurrent(context)
        || !isPetOnboardingSafe({
          petType: petTypeRef.current,
          hasSession: hasSessionRef.current,
          userId: userIdRef.current,
          relationship: relationshipRef.current,
          visibilityState: document.visibilityState,
          systemIdleSeconds: postClaimIdleSeconds,
          voicePhase: phaseRef.current,
          pointerActive: dragRef.current.pointerId !== null,
          settlingPointer: settlingPointerRef.current,
          activeCareAction: activeCareActionRef.current,
          transientBubble: transientBubbleRef.current,
          animationState: petAnimationStateRef.current,
          milestonePlayback: milestonePlaybackRef.current,
          milestoneRequestInFlight: milestoneRequestInFlightRef.current,
          companionRequestInFlight: companionRequestInFlightRef.current,
          onboardingState: claimedState,
          activeGuide: null,
        })
      ) {
        const releaseResponse = await window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          stepId,
          token,
          createExpectedPetAccountContext(context),
        )
        applyOnboardingMutationResponse(releaseResponse, context)
        return
      }

      const guide = {
        stepId,
        token,
        context,
        copy: getPetOnboardingCopy(stepId, languageRef.current, relationshipRef.current),
      }
      onboardingGuideRef.current = guide
      setOnboardingGuide(guide)
      if (stepId === PET_ONBOARDING_STEPS.MEET_PET) {
        dispatchPetAnimation({
          type: 'COMPANION_ACTION',
          action: ANIMATION_ACTIONS.LOOK_AROUND,
        })
      }
      onboardingGuideTimerRef.current = window.setTimeout(() => {
        onboardingGuideTimerRef.current = null
        const current = onboardingGuideRef.current
        if (!current || current.stepId !== stepId || current.token !== token) {
          return
        }
        if (getPetOnboardingGuideTimeoutAction(stepId) === 'ack') {
          void completeOnboardingGuide(stepId, token)
        } else {
          void interruptOnboardingGuide('display-timeout')
        }
      }, ONBOARDING_GUIDE_DURATION_MS[stepId])
      loggerRef.current.event('onboarding:playing', { stepId })
    } catch (error) {
      loggerRef.current.error('onboarding:pump-failed', error, { stepId })
    } finally {
      if (onboardingRequestInFlightRef.current === requestKey) {
        onboardingRequestInFlightRef.current = null
      }
    }
  }, [
    applyOnboardingMutationResponse,
    completeOnboardingGuide,
    getOnboardingContext,
    interruptOnboardingGuide,
    isOnboardingContextCurrent,
  ])

  onboardingPumpRef.current = runOnboardingPump

  useEffect(() => window.desktopBridge?.e2e?.onSnapshot?.(() => ({
    onboardingLoaded: onboardingStateLoadedRef.current,
    onboardingCurrent: isOnboardingContextCurrent(getOnboardingContext()),
    onboardingState: onboardingStateRef.current && {
      status: onboardingStateRef.current.status,
      revision: onboardingStateRef.current.revision,
      nextStep: deriveNextPetOnboardingStep(onboardingStateRef.current),
    },
    requestPending: Boolean(onboardingRequestInFlightRef.current),
    guide: onboardingGuideRef.current?.stepId ?? null,
    visibility: document.visibilityState,
    voicePhase: phaseRef.current,
    animation: petAnimationStateRef.current.action,
    animationLocked: petAnimationStateRef.current.locked,
    pointerActive: dragRef.current.pointerId !== null,
    settlingPointer: settlingPointerRef.current,
    careAction: activeCareActionRef.current,
    transientBubble: Boolean(transientBubbleRef.current),
    milestonePending: Boolean(milestoneRequestInFlightRef.current),
    milestonePlaying: Boolean(milestonePlaybackRef.current),
    companionPending: Boolean(companionRequestInFlightRef.current),
  })), [getOnboardingContext, isOnboardingContextCurrent])

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
      if (voiceUiState.phase !== VOICE_PHASES.IDLE) {
        void interruptOnboardingGuide('voice-active')
        void interruptMilestonePlayback('voice-active')
      } else {
        void milestonePumpRef.current?.()
        void onboardingPumpRef.current?.()
      }
    }
  }, [interruptMilestonePlayback, interruptOnboardingGuide, resetPetActivityTimer, voiceUiState.phase])

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
    userIdRef.current = userId
  }, [userId])

  useEffect(() => {
    voiceSettingsRef.current = voiceSettings
  }, [voiceSettings])

  useEffect(() => {
    companionSettingsRef.current = companionSettings
  }, [companionSettings])

  useEffect(() => {
    petAnimationStateRef.current = petAnimationState
  }, [petAnimationState])

  useEffect(() => {
    activeCareActionRef.current = activeCareAction
  }, [activeCareAction])

  useEffect(() => {
    let mounted = true
    const loadEpoch = relationshipLoadEpochRef.current + 1
    relationshipLoadEpochRef.current = loadEpoch
    const expectedContext = {
      hasSession,
      userId,
      petType,
      session: sessionSnapshotRef.current,
      authoritative: authoritativeContextRef.current,
    }
    relationshipRef.current = null
    setPetRelationship(null)
    if (!createPetAccountContextKey(expectedContext)) {
      return () => {
        mounted = false
        if (relationshipLoadEpochRef.current === loadEpoch) {
          relationshipLoadEpochRef.current += 1
        }
      }
    }
    const loadCachedRelationship = async () => {
      try {
        const operationContext = await capturePetApiOperation(expectedContext, 'pet')
        const cachedRelationship = normalizePetRelationship(
          await window.desktopBridge?.getCachedPetRelationship?.(
            petType,
            createExpectedPetAccountContext(operationContext),
          ),
          petType,
        )
        if (
          mounted
          && relationshipLoadEpochRef.current === loadEpoch
          && isPetAccountContextCurrent(expectedContext, getCurrentPetAccountContext())
          && isPetRelationshipForAccountContext(cachedRelationship, expectedContext)
        ) {
          relationshipRef.current = cachedRelationship
          setPetRelationship(cachedRelationship)
        }
      } catch (error) {
        loggerRef.current.error('outfit:cache-load-failed', error, { petType })
      }
    }
    void loadCachedRelationship()
    return () => {
      mounted = false
      if (relationshipLoadEpochRef.current === loadEpoch) {
        relationshipLoadEpochRef.current += 1
      }
    }
  }, [
    capturePetApiOperation,
    getCurrentPetAccountContext,
    hasSession,
    petType,
    sessionSnapshot?.generation,
    sessionSnapshot?.token,
    userId,
  ])

  useEffect(() => {
    let mounted = true
    const expectedContext = {
      hasSession,
      userId,
      petType,
      session: sessionSnapshotRef.current,
      authoritative: authoritativeContextRef.current,
    }
    companionStateRef.current = DEFAULT_COMPANION_STATE
    companionStateReadyRef.current = false
    const requestContext = companionLoadGateRef.current.begin(expectedContext)

    if (!createPetAccountContextKey(expectedContext)) {
      return () => {
        mounted = false
      }
    }

    const loadCompanionState = async () => {
      await runAccountOperation({
        gate: companionLoadGateRef.current,
        requestContext,
        getCurrentContext: () => mounted ? getCurrentPetAccountContext() : null,
        operation: async () => {
          const operationContext = await capturePetApiOperation(expectedContext, 'pet')
          return Promise.all([
            window.desktopBridge?.getCompanionSettings?.(),
            window.desktopBridge?.getCompanionState?.(
              petType,
              createExpectedPetAccountContext(operationContext),
            ),
          ])
        },
        onSuccess: ([savedSettings, savedState]) => {
          const nextSettings = normalizeCompanionSettings(savedSettings)
          const nextState = normalizeCompanionState(savedState)
          companionSettingsRef.current = nextSettings
          companionStateRef.current = nextState
          companionStateReadyRef.current = true
          setCompanionSettings(nextSettings)
        },
        onError: (error) => {
          companionStateReadyRef.current = true
          loggerRef.current.error('companion:state-load-failed', error, { petType })
        },
      })
    }

    void loadCompanionState()
    return () => {
      mounted = false
      companionLoadGateRef.current.invalidate()
    }
  }, [
    capturePetApiOperation,
    getCurrentPetAccountContext,
    hasSession,
    petType,
    sessionSnapshot?.generation,
    sessionSnapshot?.token,
    userId,
  ])

  useEffect(() => {
    hasSessionRef.current = hasSession
  }, [hasSession])

  useEffect(() => {
    let mounted = true
    const epoch = onboardingContextEpochRef.current + 1
    onboardingContextEpochRef.current = epoch
    onboardingGuideCooldownRef.current = {}
    onboardingStateLoadedRef.current = false
    setOnboardingStateLoaded(false)
    onboardingEngagementTickRef.current = Date.now()
    void interruptOnboardingGuide('context-change')
    replaceOnboardingRuntimeState(null)

    const expectedUserId = Number(userId)
    const expectedRelationshipId = Number(petRelationship?.id)
    const context = {
      epoch,
      userId: expectedUserId,
      relationshipId: expectedRelationshipId,
      session: sessionSnapshotRef.current,
      authoritative: authoritativeContextRef.current,
    }
    const contextEligible = (
      petType === 'pig'
      && hasSession
      && Number.isInteger(expectedUserId)
      && expectedUserId > 0
      && petRelationship?.pet_type === 'pig'
      && Number.isInteger(expectedRelationshipId)
      && expectedRelationshipId > 0
      && Number(petRelationship?.user_id) === expectedUserId
    )

    if (!contextEligible) {
      onboardingStateLoadedRef.current = true
      setOnboardingStateLoaded(true)
      return () => {
        mounted = false
        if (onboardingContextEpochRef.current === epoch) {
          onboardingContextEpochRef.current += 1
        }
      }
    }

    const acceptState = (value) => {
      if (!mounted || !isOnboardingContextCurrent(context)) {
        return
      }
      const normalized = normalizePetOnboardingStateResponse(value)
      if (
        normalized
        && (
          normalized.user_id !== expectedUserId
          || normalized.relationship_id !== expectedRelationshipId
        )
      ) {
        return
      }
      replaceOnboardingRuntimeState(normalized, context)
      onboardingStateLoadedRef.current = true
      setOnboardingStateLoaded(true)
      void onboardingPumpRef.current?.()
    }

    const unsubscribe = window.desktopBridge?.onPetOnboardingChanged?.(acceptState)
    void window.desktopBridge?.getPetOnboardingState?.(
      'pig',
      createExpectedPetAccountContext(context),
    )
      .then(acceptState)
      .catch((error) => {
        loggerRef.current.error('onboarding:state-load-failed', error)
        if (mounted && isOnboardingContextCurrent(context)) {
          onboardingStateLoadedRef.current = true
          setOnboardingStateLoaded(true)
        }
      })

    return () => {
      mounted = false
      unsubscribe?.()
      if (onboardingContextEpochRef.current === epoch) {
        onboardingContextEpochRef.current += 1
      }
    }
  }, [
    capturePetApiOperation,
    hasSession,
    interruptOnboardingGuide,
    isOnboardingContextCurrent,
    petRelationship?.id,
    petRelationship?.pet_type,
    petRelationship?.user_id,
    petType,
    replaceOnboardingRuntimeState,
    sessionSnapshot?.generation,
    sessionSnapshot?.token,
    userId,
  ])

  useEffect(() => {
    if (petType !== 'pig' || !hasSession) {
      return undefined
    }
    const poll = () => {
      void onboardingPumpRef.current?.()
    }
    poll()
    onboardingPumpTimerRef.current = window.setInterval(poll, ONBOARDING_POLL_INTERVAL_MS)
    return () => {
      if (onboardingPumpTimerRef.current) {
        window.clearInterval(onboardingPumpTimerRef.current)
        onboardingPumpTimerRef.current = null
      }
    }
  }, [hasSession, petType])

  useEffect(() => {
    onboardingEngagementTickRef.current = Date.now()
    if (petType !== 'pig' || !hasSession) {
      return undefined
    }
    const tick = async () => {
      const currentTickMs = Date.now()
      const previousTickMs = onboardingEngagementTickRef.current
      onboardingEngagementTickRef.current = currentTickMs
      const context = getOnboardingContext()
      if (
        onboardingEngagementInFlightRef.current
        || !onboardingStateLoadedRef.current
        || !isOnboardingContextCurrent(context)
      ) {
        return
      }
      onboardingEngagementInFlightRef.current = true
      try {
        const idleSeconds = await window.desktopBridge?.getSystemIdleSeconds?.()
        if (!isOnboardingContextCurrent(context)) {
          return
        }
        const deltaMs = getPetOnboardingEngagementDelta({
          previousTickMs,
          currentTickMs,
          documentVisible: document.visibilityState === 'visible',
          systemIdleSeconds: idleSeconds,
          state: onboardingStateRef.current,
        })
        if (!deltaMs) {
          return
        }
        const response = await window.desktopBridge?.recordPetOnboardingEngagement?.(
          'pig',
          deltaMs,
          createExpectedPetAccountContext(context),
        )
        applyOnboardingMutationResponse(response, context)
      } catch (error) {
        loggerRef.current.error('onboarding:engagement-failed', error)
      } finally {
        onboardingEngagementInFlightRef.current = false
      }
    }
    const timer = window.setInterval(() => void tick(), ONBOARDING_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [
    applyOnboardingMutationResponse,
    getOnboardingContext,
    hasSession,
    isOnboardingContextCurrent,
    petType,
  ])

  useEffect(() => {
    let mounted = true
    const epoch = milestoneContextEpochRef.current + 1
    milestoneContextEpochRef.current = epoch
      const expectedAccountContext = {
        hasSession,
        userId,
        petType,
        session: sessionSnapshotRef.current,
        authoritative: authoritativeContextRef.current,
        relationshipId: petRelationship?.id ?? null,
    }
    const accountContextKey = createPetAccountContextKey(expectedAccountContext)
    milestoneAccountContextKeyRef.current = accountContextKey
    milestonePlaybackLoadedRef.current = false
    replaceMilestoneRuntimeState(null)

    if (petType !== 'pig' || !accountContextKey) {
      return () => {
        mounted = false
        if (milestoneContextEpochRef.current === epoch) {
          milestoneContextEpochRef.current += 1
          milestoneAccountContextKeyRef.current = null
        }
      }
    }

    const loadMilestonePlayback = async () => {
      try {
        const operationContext = await capturePetApiOperation(expectedAccountContext, 'relationship')
        let savedPlayback = normalizePetMilestonePlaybackState(
          await window.desktopBridge?.getPetMilestonePlayback?.(
            'pig',
            createExpectedPetAccountContext(operationContext),
          ),
          'pig',
        )
        if (!mounted || !isMilestoneContextCurrent(epoch)) {
          return
        }
        if (savedPlayback?.status === PET_MILESTONE_PLAYBACK_STATUS.PLAYING) {
          savedPlayback = updatePetMilestonePlaybackStatus(
            savedPlayback,
            PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
          )
          replaceMilestoneRuntimeState(savedPlayback)
          try {
            const storedQueued = await persistMilestonePlaybackState(
              savedPlayback,
              epoch,
              operationContext,
            )
            if (!isMilestoneContextCurrent(epoch)) {
              return
            }
            replaceMilestoneRuntimeState(storedQueued)
          } catch (error) {
            loggerRef.current.error('milestone:restart-requeue-failed', error, {
              milestoneId: savedPlayback?.milestone?.id,
            })
          }
        } else {
          replaceMilestoneRuntimeState(savedPlayback)
        }
      } catch (error) {
        loggerRef.current.error('milestone:state-load-failed', error)
      } finally {
        if (mounted && isMilestoneContextCurrent(epoch)) {
          milestonePlaybackLoadedRef.current = true
          void milestonePumpRef.current?.()
        }
      }
    }

    void loadMilestonePlayback()
    return () => {
      mounted = false
      if (milestoneContextEpochRef.current === epoch) {
        milestoneContextEpochRef.current += 1
        milestoneAccountContextKeyRef.current = null
        milestonePlaybackLoadedRef.current = false
      }
    }
  }, [
    capturePetApiOperation,
    hasSession,
    isMilestoneContextCurrent,
    persistMilestonePlaybackState,
    petType,
    replaceMilestoneRuntimeState,
    sessionSnapshot?.generation,
      sessionSnapshot?.token,
      petRelationship?.id,
      userId,
  ])

  useEffect(() => {
    if (petType !== 'pig' || !hasSession) {
      return undefined
    }
    const poll = () => {
      void milestonePumpRef.current?.()
    }
    poll()
    milestonePumpTimerRef.current = window.setInterval(poll, MILESTONE_POLL_INTERVAL_MS)
    return () => {
      if (milestonePumpTimerRef.current) {
        window.clearInterval(milestonePumpTimerRef.current)
        milestonePumpTimerRef.current = null
      }
    }
  }, [hasSession, petType, userId])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        void interruptOnboardingGuide('window-hidden')
        void interruptMilestonePlayback('window-hidden')
        return
      }
      void milestonePumpRef.current?.()
      void onboardingPumpRef.current?.()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [interruptMilestonePlayback, interruptOnboardingGuide])

  useEffect(() => {
    if (
      petType === 'pig'
      && hasSession
      && voiceUiState.phase === VOICE_PHASES.IDLE
      && !activeCareAction
      && !transientBubble
      && petAnimationState.action === ANIMATION_ACTIONS.IDLE
    ) {
      void milestonePumpRef.current?.()
    }
  }, [
    activeCareAction,
    hasSession,
    petAnimationState.action,
    petRelationship,
    petType,
    transientBubble,
    voiceUiState.phase,
  ])

  useEffect(() => {
    resetPetActivityTimer()
    return () => clearSleepTimer()
  }, [clearSleepTimer, resetPetActivityTimer])

  useEffect(() => {
    let mounted = true

    const syncState = async ({ refreshRemote = false } = {}) => {
      try {
        const [savedLanguage, session, bounds, storedPetState, storedVoiceSettings] = await Promise.all([
          getLanguage(),
          getSessionSnapshot(),
          window.desktopBridge?.getPetBounds?.(),
          window.desktopBridge?.getPetState?.(),
          getVoiceSettings(),
        ])

        if (!mounted) {
          return
        }

        const nextPetType = storedPetState?.petType || petTypeRef.current
        const token = session?.token
        const nextHasSession = Boolean(token)
        const nextUserId = Number.isInteger(storedPetState?.userId) && storedPetState.userId > 0
          ? storedPetState.userId
          : null
        const currentContext = getCurrentPetAccountContext()
        if (
          currentContext.hasSession !== nextHasSession
          || currentContext.userId !== nextUserId
          || currentContext.petType !== nextPetType
        ) {
          clearRelationshipScopedRuntime('pet-state-refresh')
        }
        hasSessionRef.current = nextHasSession
        sessionSnapshotRef.current = session
        setSessionSnapshotState(session)
        userIdRef.current = nextUserId
        petTypeRef.current = nextPetType
        setLanguageState(normalizeLanguage(savedLanguage || storedPetState?.language))
        setHasSession(nextHasSession)
        setUserId(nextUserId)
        setVoiceSettings(normalizeVoiceSettings(storedVoiceSettings))

        if (bounds?.x !== undefined && bounds?.y !== undefined) {
          petPositionRef.current = bounds
        }

        if (storedPetState?.petType) {
          setPetType(nextPetType)
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
          clearRelationshipScopedRuntime('pet-state-refresh-failed')
          hasSessionRef.current = false
          userIdRef.current = null
          petTypeRef.current = 'cat'
          authoritativeContextRef.current = null
          setHasSession(false)
          setUserId(null)
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
  }, [clearRelationshipScopedRuntime, getCurrentPetAccountContext])

  useEffect(() => {
    const unsubscribePet = window.desktopBridge?.onPetStateChanged?.((payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }

      if (payload.language) {
        setLanguageState(normalizeLanguage(payload.language))
      }

      const currentContext = getCurrentPetAccountContext()
      const nextPetType = payload.petType || currentContext.petType
      const nextUserId = Object.prototype.hasOwnProperty.call(payload, 'userId')
        ? (Number.isInteger(payload.userId) && payload.userId > 0 ? payload.userId : null)
        : currentContext.userId
      const nextHasSession = typeof payload.hasSession === 'boolean'
        ? payload.hasSession
        : currentContext.hasSession
      if (
        currentContext.petType !== nextPetType
        || currentContext.userId !== nextUserId
        || currentContext.hasSession !== nextHasSession
      ) {
        sessionSnapshotRef.current = null
        authoritativeContextRef.current = null
        setSessionSnapshotState(null)
        sessionSyncEpochRef.current += 1
        clearRelationshipScopedRuntime('pet-state-changed')
      }

      petTypeRef.current = nextPetType
      userIdRef.current = nextUserId
      hasSessionRef.current = nextHasSession
      const sessionSyncEpoch = sessionSyncEpochRef.current
      if (nextHasSession) {
        void getSessionSnapshot().then(async (session) => {
          const adopted = payload.authoritative
            ? await adoptPetStateCapability({
                payload,
                currentContext: { hasSession: nextHasSession, userId: nextUserId, petType: nextPetType },
                validateCapability: (capability, requiredScope, semantic) => (
                  window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
                ),
              })
            : null
          if (
            sessionSyncEpochRef.current === sessionSyncEpoch
            && hasSessionRef.current
            && userIdRef.current === nextUserId
            && petTypeRef.current === nextPetType
          ) {
            sessionSnapshotRef.current = session
            authoritativeContextRef.current = adopted?.authoritative || null
            setSessionSnapshotState(session)
          }
        })
      } else {
        sessionSnapshotRef.current = null
        authoritativeContextRef.current = null
        setSessionSnapshotState(null)
      }

      if (payload.petType) {
        setPetType(nextPetType)
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'userId')) {
        setUserId(nextUserId)
      }

      if (payload.preferences) {
        setPreferences((current) => ({
          ...current,
          ...payload.preferences,
        }))
      }

      if (typeof payload.hasSession === 'boolean') {
        setHasSession(nextHasSession)
      }
    })

    const unsubscribeVoice = window.desktopBridge?.onVoiceSettingsChanged?.((payload) => {
      const nextSettings = normalizeVoiceSettings(payload)
      setVoiceSettings(nextSettings)
      managerRef.current?.updateSettings?.(nextSettings)
    })

    const unsubscribeCompanionSettings = window.desktopBridge?.onCompanionSettingsChanged?.((payload) => {
      const nextSettings = normalizeCompanionSettings(payload)
      companionSettingsRef.current = nextSettings
      setCompanionSettings(nextSettings)
    })

    const unsubscribeCompanionState = window.desktopBridge?.onCompanionStateChanged?.((payload) => {
      if (payload?.cleared) {
        companionStateRef.current = DEFAULT_COMPANION_STATE
        companionStateReadyRef.current = false
        return
      }
      if (
        payload?.pet_type === petTypeRef.current
        && Number(payload?.user_id) === Number(userIdRef.current)
      ) {
        companionStateRef.current = normalizeCompanionState(payload.state)
        companionStateReadyRef.current = true
      }
    })

    const unsubscribeRelationship = window.desktopBridge?.onPetRelationshipChanged?.((payload) => {
      if (payload === null || payload === undefined) {
        clearRelationshipScopedRuntime('relationship-cleared')
        return
      }
      void (async () => {
        const adopted = await adoptRelationshipCapability({
          payload,
          currentContext: getCurrentPetAccountContext(),
          validateCapability: (capability, requiredScope, semantic) => (
            window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
          ),
        })
        if (!adopted) return
        const relationship = normalizePetRelationship(adopted.relationship, petTypeRef.current)
        if (relationship?.pet_type === petTypeRef.current) {
        authoritativeContextRef.current = adopted.authoritative
        const previousRelationship = relationshipRef.current
        relationshipRef.current = relationship
        setPetRelationship(relationship)
        if (relationship.pet_type === 'pig') {
          void milestonePumpRef.current?.()
          void onboardingPumpRef.current?.()
        }
        if (!previousRelationship) {
          return
        }
        if (
          relationship.pet_type !== 'pig'
          && relationship.level > previousRelationship.level
        ) {
          const message = getPetRelationshipEventCopy(
            relationship.pet_type,
            languageRef.current,
            'level_up',
            relationship,
          )
          setTransientBubbleForDuration(message, 3600)
          dispatchPetAnimation({ type: 'LEVEL_UP', message })
          return
        }
        if (didEquippedOutfitChange(previousRelationship, relationship)) {
          void interruptOnboardingGuide('outfit-change')
          void interruptMilestonePlayback('outfit-change')
          const message = getPetRelationshipEventCopy(
            relationship.pet_type,
            languageRef.current,
            'dress_up',
            relationship,
          )
          setTransientBubbleForDuration(message, 2800)
          dispatchPetAnimation({ type: 'PET_DRESS_UP', message })
        }
        }
      })()
    })

    return () => {
      unsubscribePet?.()
      unsubscribeVoice?.()
      unsubscribeCompanionSettings?.()
      unsubscribeCompanionState?.()
      unsubscribeRelationship?.()
    }
  }, [
    clearRelationshipScopedRuntime,
    getCurrentPetAccountContext,
    interruptMilestonePlayback,
    interruptOnboardingGuide,
    setTransientBubbleForDuration,
  ])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetReminderEvent?.((payload) => {
      if (
        !payload
        || payload.petType !== petTypeRef.current
        || Number(payload.userId) !== Number(userIdRef.current)
      ) {
        return
      }
      if (payload.type === 'created') {
        void interruptOnboardingGuide('reminder-created')
        void interruptMilestonePlayback('reminder-created')
        setTransientBubbleForDuration(payload.message, 3200)
        dispatchPetAnimation({ type: 'REMINDER_CREATED', message: payload.message })
        return
      }
      if (payload.type === 'parse_failed') {
        void interruptOnboardingGuide('reminder-parse-failed')
        void interruptMilestonePlayback('reminder-parse-failed')
        setTransientBubbleForDuration(payload.message, 3200)
        dispatchPetAnimation({ type: 'REMINDER_PARSE_FAILED', message: payload.message })
      }
    })

    return () => unsubscribe?.()
  }, [interruptMilestonePlayback, interruptOnboardingGuide, setTransientBubbleForDuration])

  useEffect(() => {
    const logger = loggerRef.current
    const manager = createDesktopVoiceSession({
      settings: voiceSettingsRef.current,
      getPetType: () => petTypeRef.current,
      getOperationContext: () => capturePetApiOperation(getCurrentPetAccountContext(), 'pet'),
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
    capturePetApiOperation,
    clearProcessingTimer,
    clearReplyTimer,
    clearTransientBubbleTimer,
    clearUiIdleTimer,
    getCurrentPetAccountContext,
    handleFatalVoiceError,
    scheduleReplyAutoHide,
  ])

  useEffect(() => {
    const showIntroUnlessOnboardingOwnsIt = () => {
      if (hasSessionRef.current && petTypeRef.current === 'pig') {
        const stableRelationship = (
          Number.isInteger(userIdRef.current)
          && userIdRef.current > 0
          && relationshipRef.current?.pet_type === 'pig'
          && Number(relationshipRef.current?.user_id) === userIdRef.current
        )
        if (!stableRelationship || !onboardingStateLoadedRef.current) {
          voiceIntroPendingRef.current = true
          return
        }
        if (onboardingStateRef.current?.status === PET_ONBOARDING_STATUS.ACTIVE) {
          voiceIntroPendingRef.current = false
          return
        }
      }
      voiceIntroPendingRef.current = false
      setTransientBubbleForDuration(
        hasSessionRef.current
          ? getVoiceIntroHint(languageRef.current)
          : t(languageRef.current, 'signInHint'),
        3400,
      )
    }

    if (previousSessionRef.current === null) {
      previousSessionRef.current = hasSession
      const introTimer = window.setTimeout(() => {
        showIntroUnlessOnboardingOwnsIt()
      }, 700)

      return () => {
        window.clearTimeout(introTimer)
      }
    }

    if (previousSessionRef.current !== hasSession) {
      previousSessionRef.current = hasSession
      voiceIntroPendingRef.current = true
      showIntroUnlessOnboardingOwnsIt()
      if (!hasSession) {
        transitionToIdle()
        void managerRef.current?.shutdownVoiceSession?.({ reason: 'signed-out' })
      }
    }
  }, [hasSession, language, setTransientBubbleForDuration, transitionToIdle])

  useEffect(() => {
    if (
      !voiceIntroPendingRef.current
      || !hasSession
      || petType !== 'pig'
      || !onboardingStateLoaded
      || !Number.isInteger(userId)
      || userId <= 0
      || petRelationship?.pet_type !== 'pig'
      || Number(petRelationship?.user_id) !== userId
    ) {
      return
    }
    voiceIntroPendingRef.current = false
    if (onboardingState?.status !== PET_ONBOARDING_STATUS.ACTIVE) {
      setTransientBubbleForDuration(getVoiceIntroHint(language), 3400)
    }
  }, [
    hasSession,
    language,
    onboardingState?.status,
    onboardingStateLoaded,
    petRelationship?.id,
    petRelationship?.pet_type,
    petRelationship?.user_id,
    petType,
    setTransientBubbleForDuration,
    userId,
  ])

  useEffect(() => {
    if (idleBubbleTimerRef.current) {
      window.clearInterval(idleBubbleTimerRef.current)
      idleBubbleTimerRef.current = null
    }

    if (petType === 'pig') {
      return undefined
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
  }, [petType, preferences.bubble_frequency, setTransientBubbleForDuration, transientBubble])

  useEffect(() => {
    if (petType !== 'pig' || !hasSession) {
      return undefined
    }

    let mounted = true

    const pollCompanion = async () => {
      if (
        !mounted ||
        companionRequestInFlightRef.current ||
        petTypeRef.current !== 'pig' ||
        !hasSessionRef.current ||
        !companionStateReadyRef.current ||
        document.visibilityState !== 'visible' ||
        phaseRef.current !== VOICE_PHASES.IDLE ||
        dragRef.current.pointerId !== null ||
        transientBubbleRef.current ||
        settlingPointerRef.current ||
        activeCareActionRef.current ||
        petAnimationStateRef.current.locked ||
        !canCommitPetCompanionResult({
          onboardingGuide: onboardingGuideRef.current,
          onboardingRequestInFlight: onboardingRequestInFlightRef.current,
        })
      ) {
        return
      }

      const requestContext = getCurrentPetAccountContext()
      if (!createPetAccountContextKey(requestContext)) {
        return
      }
      const requestKey = {
        type: 'companion',
        accountContextKey: createPetAccountContextKey(requestContext),
      }
      companionRequestInFlightRef.current = requestKey
      try {
        const idleSeconds = await window.desktopBridge?.getSystemIdleSeconds?.()
        if (
          !mounted
          || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())
          || petTypeRef.current !== 'pig'
          || document.visibilityState !== 'visible'
          || !canCommitPetCompanionResult({
            onboardingGuide: onboardingGuideRef.current,
            onboardingRequestInFlight: onboardingRequestInFlightRef.current,
          })
        ) {
          return
        }

        const previousState = companionStateRef.current
        const result = evaluateCompanionOpportunity({
          now: new Date(),
          idleSeconds,
          settings: companionSettingsRef.current,
          state: previousState,
        })
        let nextState = result.state

        if (result.event) {
          let dailySummary = null
          let weeklySummary = null
          const operationContext = await capturePetApiOperation(requestContext)
          if (!isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
            return
          }
          const [dailyResult, weeklyResult] = await Promise.allSettled([
            getPetDailySummary('pig', operationContext),
            getPetWeeklySummary('pig', operationContext),
          ])
          if (dailyResult.status === 'fulfilled') {
            dailySummary = dailyResult.value
          } else {
            loggerRef.current.error('companion:daily-summary-failed', dailyResult.reason)
          }
          if (weeklyResult.status === 'fulfilled') {
            weeklySummary = weeklyResult.value
          } else {
            loggerRef.current.error('companion:weekly-summary-failed', weeklyResult.reason)
          }
          if (
            !mounted
            || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())
            || petTypeRef.current !== 'pig'
            || !hasSessionRef.current
            || document.visibilityState !== 'visible'
            || phaseRef.current !== VOICE_PHASES.IDLE
            || dragRef.current.pointerId !== null
            || transientBubbleRef.current
            || settlingPointerRef.current
            || activeCareActionRef.current
            || petAnimationStateRef.current.locked
            || milestonePlaybackRef.current?.status === PET_MILESTONE_PLAYBACK_STATUS.PLAYING
            || !canCommitPetCompanionResult({
              onboardingGuide: onboardingGuideRef.current,
              onboardingRequestInFlight: onboardingRequestInFlightRef.current,
            })
          ) {
            return
          }
          const copy = getPetCompanionCopy(
            'pig',
            languageRef.current,
            result.event,
            relationshipRef.current,
            nextState.recentCopyIds,
            dailySummary,
            weeklySummary,
          )
          if (copy) {
            setTransientBubbleForDuration(copy.text, 3600)
            const companionAction = copy.weeklyReviewKey
              ? ANIMATION_ACTIONS.HAPPY
              : result.event.action
            dispatchPetAnimation({
              type: 'COMPANION_ACTION',
              action: companionAction,
              message: copy.text,
            })
            loggerRef.current.event('companion:event', {
              type: result.event.type,
              action: companionAction,
              mood: result.event.mood,
              timeContext: result.event.timeContext,
              copyId: copy.id,
            })
            if (copy.weeklyReviewKey) {
              void markPetWeeklySummaryShown(
                'pig',
                copy.weeklyReviewKey,
                operationContext,
              ).catch((error) => {
                loggerRef.current.error('companion:weekly-summary-shown-failed', error)
              })
              try {
                await markPetWeeklySummarySeen('pig', copy.weeklyReviewKey, operationContext)
                if (!isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
                  return
                }
                nextState = recordCompanionCopy(nextState, copy.id)
              } catch (error) {
                loggerRef.current.error('companion:weekly-summary-seen-failed', error)
              }
            } else {
              nextState = recordCompanionCopy(nextState, copy.id)
            }
          }
        }

        if (!canCommitPetCompanionResult({
          onboardingGuide: onboardingGuideRef.current,
          onboardingRequestInFlight: onboardingRequestInFlightRef.current,
        }) || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
          return
        }

        if (JSON.stringify(nextState) !== JSON.stringify(previousState)) {
          companionStateRef.current = nextState
          await window.desktopBridge?.setCompanionState?.(
            'pig',
            nextState,
            createExpectedPetAccountContext(requestContext),
          )
        }
      } catch (error) {
        loggerRef.current.error('companion:poll-failed', error)
      } finally {
        if (companionRequestInFlightRef.current === requestKey) {
          companionRequestInFlightRef.current = null
        }
        void onboardingPumpRef.current?.()
      }
    }

    const initialTimer = window.setTimeout(() => {
      void pollCompanion()
    }, 4200)
    const timer = window.setInterval(() => {
      void pollCompanion()
    }, COMPANION_POLL_INTERVAL_MS)

    return () => {
      mounted = false
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [capturePetApiOperation, getCurrentPetAccountContext, hasSession, petType, setTransientBubbleForDuration, userId])

  useEffect(() => {
    let mounted = true
    let inFlight = false

    const poll = async () => {
      if (!hasSessionRef.current || inFlight) {
        return
      }
      inFlight = true
      const requestContext = getCurrentPetAccountContext()
      try {
        const operationContext = await capturePetApiOperation(requestContext)
        if (!mounted || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
          return
        }
        const due = await getPendingReminders(
          requestContext.petType,
          new Date(),
          false,
          operationContext,
        )
        if (
          !mounted
          || !due.length
          || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())
        ) {
          return
        }
        const reminder = due[0]
        const copy = getPetReminderCopy(requestContext.petType).reminderDue(reminder.title)
        await interruptOnboardingGuide('reminder-due')
        await interruptMilestonePlayback('reminder-due')
        if (!isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
          return
        }
        setTransientBubbleForDuration(copy, 8000)
        dispatchPetAnimation({ type: 'REMINDER_DUE', message: copy })
        const notificationShown = await window.desktopBridge?.showNotification?.({
          title: 'Detachym',
          body: copy,
        }, operationContext.authoritative)
        if (
          notificationShown !== true
          || !isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())
        ) {
          return
        }
        await markReminderTriggered(reminder.id, operationContext)
      } catch (error) {
        loggerRef.current.error('reminder:poll-failed', error)
      } finally {
        inFlight = false
      }
    }

    reminderPollRef.current = poll
    void poll()
    const timer = window.setInterval(poll, REMINDER_POLL_INTERVAL_MS)
    return () => {
      mounted = false
      if (reminderPollRef.current === poll) {
        reminderPollRef.current = null
      }
      window.clearInterval(timer)
    }
  }, [
    getCurrentPetAccountContext,
    capturePetApiOperation,
    hasSession,
    interruptMilestonePlayback,
    interruptOnboardingGuide,
    petType,
    setTransientBubbleForDuration,
    userId,
  ])

  useEffect(() => window.desktopBridge?.e2e?.onFlushReminderPoll?.(() => (
    reminderPollRef.current?.()
  )), [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        phaseRef.current !== VOICE_PHASES.IDLE ||
        dragRef.current.pointerId !== null ||
        transientBubbleRef.current ||
        settlingPointerRef.current ||
        onboardingGuideRef.current ||
        onboardingRequestInFlightRef.current
      ) {
        return
      }
      const idleActions =
        petTypeRef.current === 'pig'
          ? [
              ANIMATION_ACTIONS.WALK,
              ANIMATION_ACTIONS.JUMP,
              ANIMATION_ACTIONS.LOOK_AROUND,
              ANIMATION_ACTIONS.STRETCH,
            ]
          : [ANIMATION_ACTIONS.WALK, ANIMATION_ACTIONS.JUMP]
      dispatchPetAnimation({ type: 'IDLE_TICK', action: pickRandom(idleActions) })
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

    await interruptOnboardingGuide('voice-enter')

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

    await interruptMilestonePlayback('voice-enter')
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
        setUserId(null)
        userIdRef.current = null
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
    interruptMilestonePlayback,
    interruptOnboardingGuide,
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
      if (intimacyFeedbackTimerRef.current) {
        window.clearTimeout(intimacyFeedbackTimerRef.current)
      }
      if (onboardingGuideTimerRef.current) {
        window.clearTimeout(onboardingGuideTimerRef.current)
        onboardingGuideTimerRef.current = null
      }
      const guide = onboardingGuideRef.current
      onboardingGuideRef.current = null
      if (guide) {
        void window.desktopBridge?.releasePetOnboardingPresentation?.(
          'pig',
          guide.stepId,
          guide.token,
          createExpectedPetAccountContext(guide.context),
        )
      }
    },
    [],
  )

  const rewardInteraction = useCallback(
    async (action) => {
      if (!hasSessionRef.current) {
        return null
      }

      try {
        const requestContext = getCurrentPetAccountContext()
        const operationContext = await capturePetApiOperation(requestContext)
        if (!isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
          return null
        }
        const result = await rewardPetRelationship(
          petTypeRef.current,
          action,
          createRewardIdempotencyKey(petTypeRef.current, action),
          operationContext,
        )
        if (!isPetAccountOperationCurrent(requestContext, getCurrentPetAccountContext())) {
          return null
        }
        if (result.relationship) {
          const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
            result.relationship,
            operationContext,
          )
          if (cacheResult?.authoritative) {
            authoritativeContextRef.current = cacheResult.authoritative
          }
          await assertApiOperationContextCurrent({
            ...operationContext,
            authoritative: cacheResult?.authoritative,
          })
          if (!canCommitRelationshipReward({
            cacheResult,
            expectedContext: requestContext,
            currentContext: getCurrentPetAccountContext(),
          })) {
            return null
          }
        }
        if (result.awarded_xp > 0) {
          const label = languageRef.current === 'zh-CN' ? '亲密度' : 'Intimacy'
          showIntimacyFeedback(`+${result.awarded_xp} ${label}`)
        }
        loggerRef.current.event('intimacy:reward', {
          action,
          reason: result.reason,
          awardedXp: result.awarded_xp,
          level: result.relationship?.level,
        })
        return result
      } catch (error) {
        loggerRef.current.error('intimacy:reward-failed', error, { action })
        return null
      }
    },
    [capturePetApiOperation, getCurrentPetAccountContext, showIntimacyFeedback],
  )

  useEffect(() => {
    if (hasSession && preferences.pet_type === petType) {
      void rewardInteraction('daily_first_wake')
    }
  }, [hasSession, petType, preferences.pet_type, rewardInteraction])

  const careActions = useMemo(() => getPetCareActions(language, petType), [language, petType])

  const handleCareAction = useCallback(
    (event, action) => {
      event.preventDefault()
      event.stopPropagation()
      if (
        !action ||
        activeCareAction ||
        doesPetAnimationBlockCare(petAnimationState.action, petAnimationState.locked) ||
        phaseRef.current !== VOICE_PHASES.IDLE
      ) {
        return
      }

      resetPetActivityTimer()
      void recordOnboardingInteraction(`care:${action.id}`)
      void interruptMilestonePlayback('care')
      activeCareActionRef.current = action.id
      setActiveCareAction(action.id)
      setTransientBubbleForDuration(action.message, 2400)
      dispatchPetAnimation({ type: action.animationEvent })
      void rewardInteraction(action.rewardAction)
    },
    [
      activeCareAction,
      interruptMilestonePlayback,
      petAnimationState.action,
      petAnimationState.locked,
      recordOnboardingInteraction,
      resetPetActivityTimer,
      rewardInteraction,
      setTransientBubbleForDuration,
    ],
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

    void interruptMilestonePlayback('pointer-down')
    void interruptOnboardingGuide('pointer-down')
    const wasSleeping = petAnimationState.action === ANIMATION_ACTIONS.SLEEPING
    resetPetActivityTimer()
    if (wasSleeping) {
      const message = getPetRelationshipEventCopy(
        petTypeRef.current,
        languageRef.current,
        'wake',
        petRelationship,
      )
      setTransientBubbleForDuration(message, 2400)
      dispatchPetAnimation({ type: 'WAKE', message })
    }
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
      wokeFromSleep: wasSleeping,
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
      dispatchPetAnimation({ type: 'PET_DRAG_START' })
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
    const wokeFromSleep = dragRef.current.wokeFromSleep
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
      wokeFromSleep: false,
    }
    settlingPointerRef.current = false

    if (didMove || wokeFromSleep) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 240)
    }

    if (didMove) {
      dispatchPetAnimation({ type: 'PET_DRAG_RELEASE' })
      void recordOnboardingInteraction('drag-release')
      void rewardInteraction('drag_release')
      setTransientBubbleForDuration(t(languageRef.current, 'dragSaved'), 1500)
    }
  }

  const handleClick = () => {
    if (suppressClickRef.current) {
      return
    }
    resetPetActivityTimer()
    void recordOnboardingInteraction('pet-click')
    void interruptMilestonePlayback('pet-click')
    dispatchPetAnimation({ type: 'PET_CLICK' })
    void rewardInteraction('poke')
    void handleEnterVoiceMode()
  }

  const completeMilestonePlayback = useCallback(
    async (milestoneId) => {
      const epoch = milestoneContextEpochRef.current
      const current = milestonePlaybackRef.current
      if (
        !isMilestoneContextCurrent(epoch)
        || milestoneRequestInFlightRef.current?.epoch === epoch
        || current?.status !== PET_MILESTONE_PLAYBACK_STATUS.PLAYING
        || current.milestone?.id !== milestoneId
        || petAnimationStateRef.current.milestoneId !== milestoneId
      ) {
        return false
      }

      const ackPending = createPetMilestonePlaybackState({
        petType: 'pig',
        status: PET_MILESTONE_PLAYBACK_STATUS.ACK_PENDING,
        claimToken: current.claim_token,
        milestone: current.milestone,
        displayed: true,
        revision: current.revision,
      })
      replaceMilestoneRuntimeState(ackPending)
      const requestKey = { epoch, type: 'complete' }
      milestoneRequestInFlightRef.current = requestKey
      try {
        const operationContext = await capturePetApiOperation(
          { ...getCurrentPetAccountContext(), relationshipId: relationshipRef.current?.id },
          'relationship',
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return false
        }
        const storedAckPending = await persistMilestonePlaybackState(
          ackPending,
          epoch,
          operationContext,
        )
        if (!isMilestoneContextCurrent(epoch)) {
          return false
        }
        if (milestonePlaybackRef.current?.claim_token !== storedAckPending.claim_token) {
          return false
        }
        replaceMilestoneRuntimeState(storedAckPending)
        await acknowledgeMilestonePlayback(storedAckPending, epoch, operationContext)
        return true
      } catch (error) {
        loggerRef.current.error('milestone:ack-pending-persist-failed', error, {
          milestoneId,
        })
        return false
      } finally {
        if (milestoneRequestInFlightRef.current === requestKey) {
          milestoneRequestInFlightRef.current = null
        }
      }
    },
    [
      acknowledgeMilestonePlayback,
      capturePetApiOperation,
      getCurrentPetAccountContext,
      isMilestoneContextCurrent,
      persistMilestonePlaybackState,
      replaceMilestoneRuntimeState,
    ],
  )

  const handlePetAnimationCycleComplete = useCallback(
    (completedAction, completedMilestoneId) => {
      const currentAnimation = petAnimationStateRef.current
      if (completedAction !== currentAnimation.action) {
        return
      }
      if (currentAnimation.milestoneId) {
        if (
          completedAction !== ANIMATION_ACTIONS.LEVEL_UP
          || completedMilestoneId !== currentAnimation.milestoneId
          || milestonePlaybackRef.current?.milestone?.id !== completedMilestoneId
          || milestonePlaybackRef.current?.status !== PET_MILESTONE_PLAYBACK_STATUS.PLAYING
        ) {
          return
        }
        setActiveCareAction('')
        dispatchPetAnimation({
          type: 'ANIMATION_DONE',
          milestoneId: completedMilestoneId,
        })
        void completeMilestonePlayback(completedMilestoneId)
        return
      }

      setActiveCareAction('')
      dispatchPetAnimation({ type: 'ANIMATION_DONE' })
    },
    [completeMilestonePlayback],
  )

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
      <div
        className={`pet-scene mood-${petMood}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {bubbleText && <div className={`pet-bubble pet-bubble-${petType}`}>{bubbleText}</div>}
        {onboardingGuide?.copy && (
          <div
            className={`pet-onboarding-guide is-${onboardingGuide.stepId}`}
            data-e2e={`p1k-guide-${onboardingGuide.stepId}`}
            role="status"
            aria-live="polite"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="pet-onboarding-guide-chip">{onboardingGuide.copy.chip}</span>
            <strong className="pet-onboarding-guide-title">{onboardingGuide.copy.title}</strong>
            <span className="pet-onboarding-guide-body">{onboardingGuide.copy.body}</span>
            {onboardingGuide.stepId === PET_ONBOARDING_STEPS.RELATIONSHIP && (
              <button
                type="button"
                className="pet-onboarding-guide-action"
                data-e2e="p1k-open-relationship"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void completeOnboardingGuide(
                    onboardingGuide.stepId,
                    onboardingGuide.token,
                    { openRelationship: true },
                  )
                }}
              >
                {onboardingGuide.copy.action}
              </button>
            )}
          </div>
        )}
        {intimacyFeedback && (
          <div className="pet-intimacy-feedback" role="status" aria-live="polite">
            {intimacyFeedback}
          </div>
        )}
        {careActions.length > 0 && (
          <div
            className={`pet-care-toolbar ${
              onboardingGuide?.stepId === PET_ONBOARDING_STEPS.MEET_PET
                ? 'is-onboarding-highlight'
                : ''
            }`}
            role="toolbar"
            aria-label={getPetCareToolbarLabel(language)}
          >
            {careActions.map((action) => {
              const Icon = CARE_ACTION_ICONS[action.id]
              const disabled =
                Boolean(activeCareAction) ||
                doesPetAnimationBlockCare(petAnimationState.action, petAnimationState.locked) ||
                voiceUiState.phase !== VOICE_PHASES.IDLE

              return (
                <button
                  key={action.id}
                  type="button"
                  className="pet-care-button"
                  data-action={action.id}
                  title={action.label}
                  aria-label={action.label}
                  aria-pressed={activeCareAction === action.id}
                  disabled={disabled}
                  onClick={(event) => handleCareAction(event, action)}
                >
                  <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          className="pet-button"
          data-e2e="pet-surface"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={finishPointerInteraction}
          aria-label={t(language, 'desktopPetAlt', { pet: petLabel })}
        >
          <div className="pet-button-inner">
            <div className={`pet-visual-stack pet-action-${petAnimationState.action}`}>
              <PetAnimator
                petType={petType}
                action={petAnimationState.action}
                cycleId={petAnimationState.milestoneId}
                alt={t(language, 'desktopPetAlt', { pet: petLabel })}
                onCycleComplete={handlePetAnimationCycleComplete}
              />
              <PetOutfitRenderer
                petType={petType}
                action={petAnimationState.action}
                outfit={petRelationship?.pet_type === petType ? petRelationship.outfit : null}
                previewItemId={
                  milestonePlayback?.status === PET_MILESTONE_PLAYBACK_STATUS.PLAYING
                    && milestonePlayback.milestone?.id === petAnimationState.milestoneId
                    ? milestonePlayback.milestone.reward_outfit_id
                    : null
                }
              />
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<PetApp />)
