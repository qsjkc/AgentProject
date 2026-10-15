import { getRelationshipStageLabel } from './pet-relationship.js'

export const PET_ONBOARDING_VERSION = 1
export const PET_ONBOARDING_TIMEOUT_COOLDOWN_MS = 30_000

export const PET_ONBOARDING_STATUS = Object.freeze({
  ACTIVE: 'active',
  FINISHED: 'finished',
  DISMISSED: 'dismissed',
})

export const PET_ONBOARDING_STEPS = Object.freeze({
  MEET_PET: 'meet_pet',
  RELATIONSHIP: 'relationship',
})

export const PET_ONBOARDING_CAPABILITIES = Object.freeze({
  PET_INTERACTION: 'pet_interaction',
  RELATIONSHIP_VIEWED: 'relationship_viewed',
  REMINDER_CREATED: 'reminder_created',
  REMINDER_COMPLETED: 'reminder_completed',
})

const STEP_CAPABILITIES = Object.freeze({
  [PET_ONBOARDING_STEPS.MEET_PET]: PET_ONBOARDING_CAPABILITIES.PET_INTERACTION,
  [PET_ONBOARDING_STEPS.RELATIONSHIP]: PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
})
const STEP_IDS = Object.freeze(Object.values(PET_ONBOARDING_STEPS))
const CAPABILITY_IDS = Object.freeze(Object.values(PET_ONBOARDING_CAPABILITIES))
const STATUS_IDS = Object.freeze(Object.values(PET_ONBOARDING_STATUS))
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function normalizeKnownIds(value, knownIds) {
  if (!Array.isArray(value)) {
    return null
  }
  const ids = new Set(value.filter((id) => knownIds.includes(id)))
  return knownIds.filter((id) => ids.has(id))
}

function normalizePresentation(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (
    !isPlainObject(value)
    || !STEP_IDS.includes(value.step_id)
    || !UUID_V4_PATTERN.test(String(value.token || ''))
  ) {
    return null
  }
  const leaseExpiresAt = normalizeTimestamp(value.lease_expires_at)
  if (!leaseExpiresAt) {
    return null
  }
  return {
    step_id: value.step_id,
    token: String(value.token).toLowerCase(),
    lease_expires_at: leaseExpiresAt,
  }
}

export function normalizePetOnboardingStateResponse(value) {
  const candidate = value?.state ?? value?.playback ?? value
  if (!isPlainObject(candidate) || Number(candidate.version) !== PET_ONBOARDING_VERSION) {
    return null
  }
  const userId = normalizePositiveInteger(candidate.user_id)
  const relationshipId = normalizePositiveInteger(candidate.relationship_id)
  const engagedElapsedMs = normalizeNonNegativeInteger(candidate.engaged_elapsed_ms)
  const revision = normalizeNonNegativeInteger(candidate.revision)
  const shownStepIds = normalizeKnownIds(candidate.shown_step_ids, STEP_IDS)
  const observedCapabilityIds = normalizeKnownIds(
    candidate.observed_capability_ids,
    CAPABILITY_IDS,
  )
  if (
    userId === null
    || relationshipId === null
    || candidate.pet_type !== 'pig'
    || !STATUS_IDS.includes(candidate.status)
    || engagedElapsedMs === null
    || revision === null
    || shownStepIds === null
    || observedCapabilityIds === null
  ) {
    return null
  }

  const presentation = normalizePresentation(candidate.presentation)
  if (candidate.presentation !== null && candidate.presentation !== undefined && !presentation) {
    return null
  }
  const snoozedUntil = normalizeTimestamp(candidate.snoozed_until)
  if (candidate.snoozed_until && !snoozedUntil) {
    return null
  }
  return {
    version: PET_ONBOARDING_VERSION,
    user_id: userId,
    relationship_id: relationshipId,
    pet_type: 'pig',
    status: candidate.status,
    engaged_elapsed_ms: engagedElapsedMs,
    shown_step_ids: shownStepIds,
    observed_capability_ids: observedCapabilityIds,
    presentation,
    snoozed_until: candidate.status === PET_ONBOARDING_STATUS.ACTIVE ? snoozedUntil : null,
    revision,
  }
}

export function deriveNextPetOnboardingStep(value) {
  const state = normalizePetOnboardingStateResponse(value)
  if (!state || state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return null
  }
  const observed = new Set(state.observed_capability_ids)
  const shown = new Set(state.shown_step_ids)
  return STEP_IDS.find(
    (stepId) => !shown.has(stepId) && !observed.has(STEP_CAPABILITIES[stepId]),
  ) || null
}

export function getPetOnboardingGuideTimeoutAction(stepId) {
  if (stepId === PET_ONBOARDING_STEPS.MEET_PET) {
    return 'ack'
  }
  if (stepId === PET_ONBOARDING_STEPS.RELATIONSHIP) {
    return 'release'
  }
  return null
}

export function getPetOnboardingGuideCooldownUntil({
  stepId,
  reason,
  nowMs,
  cooldownMs = PET_ONBOARDING_TIMEOUT_COOLDOWN_MS,
}) {
  const currentMs = Number(nowMs)
  const durationMs = Number(cooldownMs)
  const needsTimeoutCooldown = (
    stepId === PET_ONBOARDING_STEPS.RELATIONSHIP
    && reason === 'display-timeout'
  )
  const needsLeaseCooldown = STEP_IDS.includes(stepId) && reason === 'lease-rejected'
  if (
    (!needsTimeoutCooldown && !needsLeaseCooldown)
    || !Number.isFinite(currentMs)
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return null
  }
  return currentMs + durationMs
}

export function isPetOnboardingGuideCoolingDown(cooldownUntilMs, nowMs) {
  const deadlineMs = Number(cooldownUntilMs)
  const currentMs = Number(nowMs)
  return Number.isFinite(deadlineMs) && Number.isFinite(currentMs) && deadlineMs > currentMs
}

export function canCommitPetCompanionResult({
  onboardingGuide,
  onboardingRequestInFlight,
}) {
  return !onboardingGuide && !onboardingRequestInFlight
}

export function shouldRecordPetOnboardingInteraction({ loaded, state }) {
  const normalizedState = normalizePetOnboardingStateResponse(state)
  return Boolean(loaded && normalizedState?.status === PET_ONBOARDING_STATUS.ACTIVE)
}

export function createPetOnboardingPresentationToken() {
  const nativeToken = globalThis.crypto?.randomUUID?.()
  if (nativeToken && UUID_V4_PATTERN.test(nativeToken)) {
    return nativeToken.toLowerCase()
  }
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isPetOnboardingContextCurrent({
  expectedEpoch,
  currentEpoch,
  expectedUserId,
  currentUserId,
  expectedRelationshipId,
  currentRelationshipId,
  petType,
  hasSession,
}) {
  const normalizedExpectedUserId = normalizePositiveInteger(expectedUserId)
  const normalizedCurrentUserId = normalizePositiveInteger(currentUserId)
  const normalizedExpectedRelationshipId = normalizePositiveInteger(expectedRelationshipId)
  const normalizedCurrentRelationshipId = normalizePositiveInteger(currentRelationshipId)
  return (
    Number.isInteger(expectedEpoch)
    && expectedEpoch === currentEpoch
    && normalizedExpectedUserId !== null
    && normalizedExpectedUserId === normalizedCurrentUserId
    && normalizedExpectedRelationshipId !== null
    && normalizedExpectedRelationshipId === normalizedCurrentRelationshipId
    && petType === 'pig'
    && Boolean(hasSession)
  )
}

export function isPetOnboardingSafe({
  petType,
  hasSession,
  userId,
  relationship,
  visibilityState,
  systemIdleSeconds,
  voicePhase,
  pointerActive,
  settlingPointer,
  activeCareAction,
  transientBubble,
  animationState,
  milestonePlayback,
  milestoneRequestInFlight,
  companionRequestInFlight,
  onboardingState,
  activeGuide,
  now = new Date(),
}) {
  const state = normalizePetOnboardingStateResponse(onboardingState)
  const expectedUserId = normalizePositiveInteger(userId)
  const relationshipId = normalizePositiveInteger(relationship?.id)
  const relationshipUserId = normalizePositiveInteger(relationship?.user_id)
  const idleSeconds = Number(systemIdleSeconds)
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const snoozedUntilMs = Date.parse(state?.snoozed_until || '')
  return Boolean(
    petType === 'pig'
    && hasSession
    && expectedUserId !== null
    && relationship?.pet_type === 'pig'
    && relationshipId !== null
    && relationshipUserId === expectedUserId
    && state
    && state.status === PET_ONBOARDING_STATUS.ACTIVE
    && state.user_id === expectedUserId
    && state.relationship_id === relationshipId
    && visibilityState === 'visible'
    && Number.isFinite(idleSeconds)
    && idleSeconds >= 0
    && idleSeconds < 60
    && voicePhase === 'idle'
    && !pointerActive
    && !settlingPointer
    && !activeCareAction
    && !transientBubble
    && animationState?.action === 'idle'
    && animationState?.locked === false
    && !milestonePlayback
    && !milestoneRequestInFlight
    && !companionRequestInFlight
    && !activeGuide
    && Number.isFinite(nowMs)
    && (!Number.isFinite(snoozedUntilMs) || snoozedUntilMs <= nowMs)
  )
}

export function getPetOnboardingEngagementDelta({
  previousTickMs,
  currentTickMs,
  documentVisible,
  systemIdleSeconds,
  state,
}) {
  const normalizedState = normalizePetOnboardingStateResponse(state)
  const elapsed = Number(currentTickMs) - Number(previousTickMs)
  const snoozedUntilMs = Date.parse(normalizedState?.snoozed_until || '')
  if (
    !normalizedState
    || normalizedState.status !== PET_ONBOARDING_STATUS.ACTIVE
    || !documentVisible
    || !Number.isFinite(Number(systemIdleSeconds))
    || Number(systemIdleSeconds) < 0
    || Number(systemIdleSeconds) >= 60
    || (Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Number(currentTickMs))
    || !Number.isFinite(elapsed)
    || elapsed <= 0
  ) {
    return 0
  }
  return Math.min(1000, Math.floor(elapsed))
}

export function getPetOnboardingCopy(stepId, language, relationship) {
  const isChinese = language === 'zh-CN'
  if (stepId === PET_ONBOARDING_STEPS.MEET_PET) {
    return {
      id: PET_ONBOARDING_STEPS.MEET_PET,
      title: isChinese ? '先认识一下' : 'Say hello first',
      body: isChinese
        ? '摸摸小猪，或拖拽它换个位置。它会记得这次互动。'
        : 'Give Pig a pat, or drag it somewhere new. It will remember the interaction.',
      chip: isChinese ? '摸摸 / 拖拽' : 'Pat / drag',
      action: '',
    }
  }
  if (stepId === PET_ONBOARDING_STEPS.RELATIONSHIP) {
    const level = Math.max(1, Math.min(5, Number(relationship?.level) || 1))
    const stage = getRelationshipStageLabel(language, relationship?.relationship_stage)
    return {
      id: PET_ONBOARDING_STEPS.RELATIONSHIP,
      title: isChinese ? `亲密度 Lv.${level} · ${stage}` : `Bond Lv.${level} · ${stage}`,
      body: isChinese
        ? '一起相处会慢慢变亲近；就算忙几天，亲密度也不会倒退。'
        : 'Time together gradually deepens your bond. Even a few busy days will never set it back.',
      chip: isChinese ? '真实关系进度' : 'Your real bond',
      action: isChinese ? '看看我们' : 'See us',
    }
  }
  return null
}
