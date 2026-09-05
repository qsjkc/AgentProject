const PET_ONBOARDING_VERSION = 1
const PET_ONBOARDING_PET_TYPE = 'pig'
const PET_ONBOARDING_NEW_RELATIONSHIP_MS = 24 * 60 * 60 * 1000
const PET_ONBOARDING_ENGAGEMENT_LIMIT_MS = 180 * 1000
const PET_ONBOARDING_ENGAGEMENT_DELTA_LIMIT_MS = 5 * 1000
const PET_ONBOARDING_PRESENTATION_LEASE_MS = 15 * 1000
const PET_ONBOARDING_SNOOZE_MS = 24 * 60 * 60 * 1000

const PET_ONBOARDING_STATUS = Object.freeze({
  ACTIVE: 'active',
  FINISHED: 'finished',
  DISMISSED: 'dismissed',
})

const PET_ONBOARDING_FINISH_REASONS = Object.freeze({
  COMPLETED: 'completed',
  TIMEOUT: 'timeout',
  DISMISSED: 'dismissed',
})

const PET_ONBOARDING_CAPABILITIES = Object.freeze({
  PET_INTERACTION: 'pet_interaction',
  RELATIONSHIP_VIEWED: 'relationship_viewed',
  REMINDER_CREATED: 'reminder_created',
  REMINDER_COMPLETED: 'reminder_completed',
})

const PET_ONBOARDING_STEPS = Object.freeze({
  MEET_PET: 'meet_pet',
  RELATIONSHIP: 'relationship',
})

const CAPABILITY_IDS = Object.freeze(Object.values(PET_ONBOARDING_CAPABILITIES))
const STEP_IDS = Object.freeze(Object.values(PET_ONBOARDING_STEPS))
const STATUS_IDS = Object.freeze(Object.values(PET_ONBOARDING_STATUS))
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STEP_CAPABILITIES = Object.freeze({
  [PET_ONBOARDING_STEPS.MEET_PET]: PET_ONBOARDING_CAPABILITIES.PET_INTERACTION,
  [PET_ONBOARDING_STEPS.RELATIONSHIP]: PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

function normalizeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function normalizeTimestamp(value) {
  const date = parseDate(value)
  return date ? date.toISOString() : null
}

function getNow(now = new Date()) {
  const date = parseDate(now)
  if (!date) {
    throw new TypeError('A valid onboarding time is required.')
  }
  return date
}

function getMonotonicStateTime(state, now = new Date()) {
  const nowMs = getNow(now).getTime()
  const createdAtMs = Date.parse(state?.created_at || '')
  const updatedAtMs = Date.parse(state?.updated_at || '')
  return new Date(Math.max(
    nowMs,
    Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
    Number.isFinite(updatedAtMs) ? updatedAtMs : nowMs,
  ))
}

function calculatePetOnboardingEngagementSample({
  previousSample = null,
  contextKey,
  requestedDeltaMs,
  monotonicNowMs,
} = {}) {
  const normalizedContextKey = typeof contextKey === 'string' && contextKey
    ? contextKey
    : null
  const requested = Number(requestedDeltaMs)
  const current = Number(monotonicNowMs)
  if (
    !normalizedContextKey
    || !Number.isFinite(requested)
    || requested <= 0
    || !Number.isFinite(current)
    || current < 0
  ) {
    return {
      acceptedDeltaMs: 0,
      sample: previousSample,
      reason: 'invalid-sample',
    }
  }

  const sample = {
    context_key: normalizedContextKey,
    monotonic_ms: current,
  }
  if (
    !isPlainObject(previousSample)
    || previousSample.context_key !== normalizedContextKey
    || !Number.isFinite(previousSample.monotonic_ms)
    || current < previousSample.monotonic_ms
  ) {
    return { acceptedDeltaMs: 0, sample, reason: 'baseline' }
  }

  const elapsedMs = Math.max(0, Math.floor(current - previousSample.monotonic_ms))
  const acceptedDeltaMs = Math.min(
    PET_ONBOARDING_ENGAGEMENT_DELTA_LIMIT_MS,
    Math.max(0, Math.floor(requested)),
    elapsedMs,
  )
  return {
    acceptedDeltaMs,
    sample,
    reason: acceptedDeltaMs > 0 ? null : 'no-elapsed-time',
  }
}

function normalizeKnownIds(value, knownIds) {
  if (!Array.isArray(value)) {
    return null
  }
  const selected = new Set(value.filter((item) => knownIds.includes(item)))
  return knownIds.filter((item) => selected.has(item))
}

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value)
}

function createPetOnboardingKey(userId, relationshipId) {
  const normalizedUserId = normalizePositiveInteger(userId)
  const normalizedRelationshipId = normalizePositiveInteger(relationshipId)
  if (normalizedUserId === null || normalizedRelationshipId === null) {
    return null
  }
  return `${normalizedUserId}:${normalizedRelationshipId}:${PET_ONBOARDING_PET_TYPE}:v${PET_ONBOARDING_VERSION}`
}

function normalizePetOnboardingContext(value) {
  if (!isPlainObject(value)) {
    return null
  }
  const userId = normalizePositiveInteger(value.user_id ?? value.userId)
  const relationshipId = normalizePositiveInteger(
    value.relationship_id ?? value.relationshipId ?? value.relationship?.id,
  )
  const relationshipUserId = normalizePositiveInteger(
    value.relationship_user_id
      ?? value.relationshipUserId
      ?? value.relationship?.user_id,
  )
  const petType = value.pet_type ?? value.petType
  const relationshipPetType = value.relationship_pet_type
    ?? value.relationshipPetType
    ?? value.relationship?.pet_type
  const hasSession = value.has_session ?? value.hasSession
  if (
    hasSession !== true
    || petType !== PET_ONBOARDING_PET_TYPE
    || relationshipPetType !== PET_ONBOARDING_PET_TYPE
    || userId === null
    || relationshipId === null
    || relationshipUserId !== userId
  ) {
    return null
  }
  return {
    has_session: true,
    user_id: userId,
    relationship_id: relationshipId,
    relationship_user_id: relationshipUserId,
    relationship_pet_type: PET_ONBOARDING_PET_TYPE,
    pet_type: PET_ONBOARDING_PET_TYPE,
    relationship_level: normalizePositiveInteger(
      value.relationship_level ?? value.relationshipLevel ?? value.relationship?.level,
    ),
    relationship_created_at: normalizeTimestamp(
      value.relationship_created_at
        ?? value.relationshipCreatedAt
        ?? value.relationship?.created_at,
    ),
  }
}

function isPetOnboardingContextEligible(context, now = new Date()) {
  const normalized = normalizePetOnboardingContext(context)
  if (!normalized || normalized.relationship_level !== 1 || !normalized.relationship_created_at) {
    return false
  }
  const nowMs = getNow(now).getTime()
  const createdAtMs = Date.parse(normalized.relationship_created_at)
  const ageMs = nowMs - createdAtMs
  return ageMs >= 0 && ageMs <= PET_ONBOARDING_NEW_RELATIONSHIP_MS
}

function normalizePresentation(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (!isPlainObject(value)) {
    return null
  }
  const stepId = STEP_IDS.includes(value.step_id) ? value.step_id : null
  const token = isUuidV4(value.token) ? value.token.toLowerCase() : null
  const leaseExpiresAt = normalizeTimestamp(value.lease_expires_at)
  if (!stepId || !token || !leaseExpiresAt) {
    return null
  }
  return {
    step_id: stepId,
    token,
    lease_expires_at: leaseExpiresAt,
  }
}

function hasAllCapabilities(state) {
  const observed = new Set(state?.observed_capability_ids || [])
  return CAPABILITY_IDS.every((capabilityId) => observed.has(capabilityId))
}

function isWaitingForOnboardingReminder(state) {
  const observed = new Set(state?.observed_capability_ids || [])
  return (
    observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED)
    && !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED)
  )
}

function normalizePetOnboardingState(value) {
  if (!isPlainObject(value) || value.version !== PET_ONBOARDING_VERSION) {
    return null
  }
  const userId = normalizePositiveInteger(value.user_id)
  const relationshipId = normalizePositiveInteger(value.relationship_id)
  const engagedElapsedMs = normalizeNonNegativeInteger(value.engaged_elapsed_ms)
  const revision = normalizeNonNegativeInteger(value.revision)
  const shownStepIds = normalizeKnownIds(value.shown_step_ids, STEP_IDS)
  const observedCapabilityIds = normalizeKnownIds(
    value.observed_capability_ids,
    CAPABILITY_IDS,
  )
  const createdAt = normalizeTimestamp(value.created_at)
  const updatedAt = normalizeTimestamp(value.updated_at)
  const status = STATUS_IDS.includes(value.status) ? value.status : null
  if (
    userId === null
    || relationshipId === null
    || value.pet_type !== PET_ONBOARDING_PET_TYPE
    || engagedElapsedMs === null
    || revision === null
    || shownStepIds === null
    || observedCapabilityIds === null
    || !createdAt
    || !updatedAt
    || !status
    || Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    return null
  }

  const reminderId = value.reminder_id === null || value.reminder_id === undefined
    ? null
    : normalizePositiveInteger(value.reminder_id)
  if (value.reminder_id !== null && value.reminder_id !== undefined && reminderId === null) {
    return null
  }
  const observed = new Set(observedCapabilityIds)
  if (
    (observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED) && reminderId === null)
    || (reminderId !== null && !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED))
    || (
      observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED)
      && !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED)
    )
  ) {
    return null
  }

  const rawSnoozedUntil = value.snoozed_until
  const snoozedUntil = rawSnoozedUntil === null || rawSnoozedUntil === undefined
    ? null
    : normalizeTimestamp(rawSnoozedUntil)
  if (rawSnoozedUntil !== null && rawSnoozedUntil !== undefined && !snoozedUntil) {
    return null
  }

  const rawCompletedAt = value.completed_at
  const completedAt = rawCompletedAt === null || rawCompletedAt === undefined
    ? null
    : normalizeTimestamp(rawCompletedAt)
  if (rawCompletedAt !== null && rawCompletedAt !== undefined && !completedAt) {
    return null
  }

  let finishReason = value.finish_reason ?? null
  let presentation = normalizePresentation(value.presentation)
  if (value.presentation !== null && value.presentation !== undefined && !presentation) {
    presentation = null
  }

  if (status === PET_ONBOARDING_STATUS.ACTIVE) {
    if (finishReason !== null || completedAt !== null) {
      return null
    }
  } else if (status === PET_ONBOARDING_STATUS.FINISHED) {
    if (
      ![
        PET_ONBOARDING_FINISH_REASONS.COMPLETED,
        PET_ONBOARDING_FINISH_REASONS.TIMEOUT,
      ].includes(finishReason)
      || !completedAt
    ) {
      return null
    }
    if (
      finishReason === PET_ONBOARDING_FINISH_REASONS.COMPLETED
      && !CAPABILITY_IDS.every((capabilityId) => observed.has(capabilityId))
    ) {
      return null
    }
    if (
      finishReason === PET_ONBOARDING_FINISH_REASONS.TIMEOUT
      && (
        engagedElapsedMs < PET_ONBOARDING_ENGAGEMENT_LIMIT_MS
        || (
          observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED)
          && !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED)
        )
      )
    ) {
      return null
    }
    presentation = null
  } else {
    if (finishReason !== PET_ONBOARDING_FINISH_REASONS.DISMISSED || !completedAt) {
      return null
    }
    presentation = null
  }

  if (completedAt && Date.parse(completedAt) < Date.parse(createdAt)) {
    return null
  }

  return {
    version: PET_ONBOARDING_VERSION,
    user_id: userId,
    relationship_id: relationshipId,
    pet_type: PET_ONBOARDING_PET_TYPE,
    status,
    finish_reason: finishReason,
    engaged_elapsed_ms: Math.min(engagedElapsedMs, PET_ONBOARDING_ENGAGEMENT_LIMIT_MS),
    shown_step_ids: shownStepIds,
    observed_capability_ids: observedCapabilityIds,
    presentation,
    reminder_id: reminderId,
    snoozed_until: status === PET_ONBOARDING_STATUS.ACTIVE ? snoozedUntil : null,
    revision,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt,
  }
}

function createPetOnboardingState(context, now = new Date()) {
  const normalizedContext = normalizePetOnboardingContext(context)
  if (!normalizedContext) {
    return null
  }
  const timestamp = getNow(now).toISOString()
  return {
    version: PET_ONBOARDING_VERSION,
    user_id: normalizedContext.user_id,
    relationship_id: normalizedContext.relationship_id,
    pet_type: PET_ONBOARDING_PET_TYPE,
    status: PET_ONBOARDING_STATUS.ACTIVE,
    finish_reason: null,
    engaged_elapsed_ms: 0,
    shown_step_ids: [],
    observed_capability_ids: [],
    presentation: null,
    reminder_id: null,
    snoozed_until: null,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
  }
}

function createDamagedPetOnboardingTombstone(context, rawState, now = new Date()) {
  const state = createPetOnboardingState(context, now)
  if (!state) {
    return null
  }
  const timestamp = getNow(now).toISOString()
  const rawRevision = isPlainObject(rawState)
    ? normalizeNonNegativeInteger(rawState.revision)
    : null
  return {
    ...state,
    status: PET_ONBOARDING_STATUS.DISMISSED,
    finish_reason: PET_ONBOARDING_FINISH_REASONS.DISMISSED,
    revision: (rawRevision ?? 0) + 1,
    updated_at: timestamp,
    completed_at: timestamp,
  }
}

function isStateForContext(state, context) {
  return Boolean(
    state
    && context
    && state.user_id === context.user_id
    && state.relationship_id === context.relationship_id
    && state.pet_type === context.pet_type,
  )
}

function commitState(state, patch, now = new Date()) {
  const timestamp = getMonotonicStateTime(state, now).toISOString()
  return normalizePetOnboardingState({
    ...state,
    ...patch,
    revision: state.revision + 1,
    updated_at: timestamp,
  })
}

function finishState(state, reason, now = new Date()) {
  const effectiveNow = getMonotonicStateTime(state, now)
  const timestamp = effectiveNow.toISOString()
  return commitState(state, {
    status: reason === PET_ONBOARDING_FINISH_REASONS.DISMISSED
      ? PET_ONBOARDING_STATUS.DISMISSED
      : PET_ONBOARDING_STATUS.FINISHED,
    finish_reason: reason,
    presentation: null,
    snoozed_until: null,
    completed_at: timestamp,
  }, effectiveNow)
}

function reconcileActiveState(state, now = new Date(), incrementRevision = true) {
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return state
  }
  const finish = (reason) => {
    if (incrementRevision) {
      return finishState(state, reason, now)
    }
    const timestamp = getMonotonicStateTime(state, now).toISOString()
    return normalizePetOnboardingState({
      ...state,
      status: PET_ONBOARDING_STATUS.FINISHED,
      finish_reason: reason,
      presentation: null,
      snoozed_until: null,
      completed_at: timestamp,
    })
  }
  if (hasAllCapabilities(state)) {
    return finish(PET_ONBOARDING_FINISH_REASONS.COMPLETED)
  }
  if (
    state.engaged_elapsed_ms >= PET_ONBOARDING_ENGAGEMENT_LIMIT_MS
    && !isWaitingForOnboardingReminder(state)
  ) {
    return finish(PET_ONBOARDING_FINISH_REASONS.TIMEOUT)
  }
  return state
}

function readPetOnboardingEntry({ states, context, now = new Date(), createIfEligible = true }) {
  const normalizedContext = normalizePetOnboardingContext(context)
  if (!normalizedContext) {
    return {
      state: null,
      states: isPlainObject(states) ? { ...states } : {},
      changed: !isPlainObject(states),
      reason: 'invalid-context',
    }
  }
  const key = createPetOnboardingKey(
    normalizedContext.user_id,
    normalizedContext.relationship_id,
  )
  const validStateMap = isPlainObject(states)
  const stateMap = validStateMap ? { ...states } : {}
  const hasStoredEntry = validStateMap && Object.prototype.hasOwnProperty.call(stateMap, key)

  if (!validStateMap) {
    const tombstone = createDamagedPetOnboardingTombstone(normalizedContext, null, now)
    stateMap[key] = tombstone
    return { state: tombstone, states: stateMap, changed: true, reason: 'recovered-corruption' }
  }

  if (!hasStoredEntry) {
    if (!createIfEligible || !isPetOnboardingContextEligible(normalizedContext, now)) {
      return { state: null, states: stateMap, changed: false, reason: 'not-eligible' }
    }
    const state = createPetOnboardingState(normalizedContext, now)
    stateMap[key] = state
    return { state, states: stateMap, changed: true, reason: 'created' }
  }

  const rawState = stateMap[key]
  let state = normalizePetOnboardingState(rawState)
  if (!state || !isStateForContext(state, normalizedContext)) {
    state = createDamagedPetOnboardingTombstone(normalizedContext, rawState, now)
    stateMap[key] = state
    return { state, states: stateMap, changed: true, reason: 'recovered-corruption' }
  }

  const reconciled = reconcileActiveState(state, now)
  const normalizedChanged = JSON.stringify(rawState) !== JSON.stringify(state)
  if (reconciled !== state) {
    state = reconciled
    stateMap[key] = state
    return { state, states: stateMap, changed: true, reason: 'reconciled' }
  }
  if (normalizedChanged) {
    state = commitState(state, {}, now)
    stateMap[key] = state
    return { state, states: stateMap, changed: true, reason: 'normalized' }
  }
  return { state, states: stateMap, changed: false, reason: null }
}

function isSnoozed(state, now = new Date()) {
  if (!state.snoozed_until) {
    return false
  }
  return Date.parse(state.snoozed_until) > getNow(now).getTime()
}

function getNextPetOnboardingStep(state) {
  const normalized = normalizePetOnboardingState(state)
  if (!normalized || normalized.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return null
  }
  const observed = new Set(normalized.observed_capability_ids)
  const shown = new Set(normalized.shown_step_ids)
  for (const stepId of STEP_IDS) {
    if (!observed.has(STEP_CAPABILITIES[stepId]) && !shown.has(stepId)) {
      return stepId
    }
  }
  return null
}

function invalidStateResult(state) {
  return { ok: false, reason: 'invalid-state', state: normalizePetOnboardingState(state) }
}

function terminalStateResult(state) {
  return { ok: false, reason: 'terminal', state }
}

function recordPetOnboardingObservation(stateValue, capabilityId, payload = {}, now = new Date()) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (!CAPABILITY_IDS.includes(capabilityId)) {
    return { ok: false, reason: 'invalid-capability', state }
  }

  const observed = new Set(state.observed_capability_ids)
  let reminderId = state.reminder_id
  if (capabilityId === PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED) {
    const incomingReminderId = normalizePositiveInteger(
      isPlainObject(payload) ? (payload.reminder_id ?? payload.reminderId) : payload,
    )
    if (incomingReminderId === null) {
      return { ok: false, reason: 'invalid-reminder', state }
    }
    if (reminderId !== null && reminderId !== incomingReminderId) {
      return { ok: false, reason: 'reminder-conflict', state }
    }
    reminderId = incomingReminderId
  }
  if (capabilityId === PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED) {
    const incomingReminderId = normalizePositiveInteger(
      isPlainObject(payload) ? (payload.reminder_id ?? payload.reminderId) : payload,
    )
    if (
      incomingReminderId === null
      || reminderId === null
      || incomingReminderId !== reminderId
      || !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED)
    ) {
      return { ok: false, reason: 'reminder-mismatch', state }
    }
  }

  if (observed.has(capabilityId)) {
    return { ok: true, state, changed: false }
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }

  observed.add(capabilityId)
  const fulfilledStep = Object.entries(STEP_CAPABILITIES).find(
    ([, mappedCapabilityId]) => mappedCapabilityId === capabilityId,
  )?.[0]
  const presentation = fulfilledStep && state.presentation?.step_id === fulfilledStep
    ? null
    : state.presentation
  let nextState = commitState(state, {
    observed_capability_ids: CAPABILITY_IDS.filter((id) => observed.has(id)),
    reminder_id: reminderId,
    presentation,
  }, now)
  nextState = reconcileActiveState(nextState, now, false)
  return { ok: true, state: nextState, changed: true }
}

function recordPetOnboardingEngagement(stateValue, deltaMs, now = new Date()) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  if (isSnoozed(state, now)) {
    return { ok: false, reason: 'snoozed', state }
  }
  const numericDeltaMs = Number(deltaMs)
  if (!Number.isFinite(numericDeltaMs) || numericDeltaMs <= 0) {
    return { ok: false, reason: 'invalid-delta', state }
  }
  const clampedDeltaMs = Math.min(
    PET_ONBOARDING_ENGAGEMENT_DELTA_LIMIT_MS,
    Math.max(1, Math.floor(numericDeltaMs)),
  )
  const nextElapsedMs = Math.min(
    PET_ONBOARDING_ENGAGEMENT_LIMIT_MS,
    state.engaged_elapsed_ms + clampedDeltaMs,
  )
  if (nextElapsedMs === state.engaged_elapsed_ms) {
    return { ok: true, state, changed: false }
  }
  let nextState = commitState(state, { engaged_elapsed_ms: nextElapsedMs }, now)
  nextState = reconcileActiveState(nextState, now, false)
  return { ok: true, state: nextState, changed: true }
}

function claimPetOnboardingPresentation(
  stateValue,
  petType,
  stepId,
  token,
  now = new Date(),
) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (
    petType !== PET_ONBOARDING_PET_TYPE
    || !STEP_IDS.includes(stepId)
    || !isUuidV4(token)
  ) {
    return { ok: false, reason: 'invalid-claim', state }
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  if (isSnoozed(state, now)) {
    return { ok: false, reason: 'snoozed', state }
  }
  const nextStepId = getNextPetOnboardingStep(state)
  if (!nextStepId) {
    return { ok: false, reason: 'no-presentation', state }
  }
  if (nextStepId !== stepId) {
    return { ok: false, reason: 'step-not-current', state }
  }

  const nowDate = getNow(now)
  const normalizedToken = token.toLowerCase()
  const currentPresentation = state.presentation
  if (
    currentPresentation
    && Date.parse(currentPresentation.lease_expires_at) > nowDate.getTime()
    && (
      currentPresentation.step_id !== stepId
      || currentPresentation.token !== normalizedToken
    )
  ) {
    return { ok: false, reason: 'presentation-busy', state }
  }

  const presentation = {
    step_id: stepId,
    token: normalizedToken,
    lease_expires_at: new Date(
      nowDate.getTime() + PET_ONBOARDING_PRESENTATION_LEASE_MS,
    ).toISOString(),
  }
  const nextState = commitState(state, { presentation }, nowDate)
  return { ok: true, state: nextState, presentation: nextState.presentation, changed: true }
}

function ackPetOnboardingPresentation(
  stateValue,
  petType,
  stepId,
  token,
  now = new Date(),
) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (
    petType !== PET_ONBOARDING_PET_TYPE
    || !STEP_IDS.includes(stepId)
    || !isUuidV4(token)
  ) {
    return { ok: false, reason: 'invalid-ack', state }
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  const normalizedToken = token.toLowerCase()
  if (
    !state.presentation
    || state.presentation.step_id !== stepId
    || state.presentation.token !== normalizedToken
  ) {
    return { ok: false, reason: 'presentation-mismatch', state }
  }
  if (Date.parse(state.presentation.lease_expires_at) <= getNow(now).getTime()) {
    return { ok: false, reason: 'lease-expired', state }
  }

  const shown = new Set(state.shown_step_ids)
  const observed = new Set(state.observed_capability_ids)
  shown.add(stepId)
  if (stepId === PET_ONBOARDING_STEPS.RELATIONSHIP) {
    observed.add(PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED)
  }
  let nextState = commitState(state, {
    shown_step_ids: STEP_IDS.filter((id) => shown.has(id)),
    observed_capability_ids: CAPABILITY_IDS.filter((id) => observed.has(id)),
    presentation: null,
  }, now)
  nextState = reconcileActiveState(nextState, now, false)
  return { ok: true, state: nextState, changed: true }
}

function releasePetOnboardingPresentation(
  stateValue,
  petType,
  stepId,
  token,
  now = new Date(),
) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (
    petType !== PET_ONBOARDING_PET_TYPE
    || !STEP_IDS.includes(stepId)
    || !isUuidV4(token)
  ) {
    return { ok: false, reason: 'invalid-release', state }
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  const normalizedToken = token.toLowerCase()
  if (
    !state.presentation
    || state.presentation.step_id !== stepId
    || state.presentation.token !== normalizedToken
  ) {
    return { ok: false, reason: 'presentation-mismatch', state }
  }
  if (Date.parse(state.presentation.lease_expires_at) <= getNow(now).getTime()) {
    return { ok: false, reason: 'lease-expired', state }
  }
  const nextState = commitState(state, { presentation: null }, now)
  return { ok: true, state: nextState, changed: true }
}

function snoozePetOnboarding(stateValue, now = new Date()) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  const nowDate = getNow(now)
  const nextState = commitState(state, {
    presentation: null,
    snoozed_until: new Date(nowDate.getTime() + PET_ONBOARDING_SNOOZE_MS).toISOString(),
  }, nowDate)
  return { ok: true, state: nextState, changed: true }
}

function dismissPetOnboarding(stateValue, now = new Date()) {
  const state = normalizePetOnboardingState(stateValue)
  if (!state) {
    return invalidStateResult(stateValue)
  }
  if (state.status === PET_ONBOARDING_STATUS.DISMISSED) {
    return { ok: true, state, changed: false }
  }
  if (state.status !== PET_ONBOARDING_STATUS.ACTIVE) {
    return terminalStateResult(state)
  }
  const nextState = finishState(
    state,
    PET_ONBOARDING_FINISH_REASONS.DISMISSED,
    now,
  )
  return { ok: true, state: nextState, changed: true }
}

module.exports = {
  PET_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_ENGAGEMENT_DELTA_LIMIT_MS,
  PET_ONBOARDING_ENGAGEMENT_LIMIT_MS,
  PET_ONBOARDING_FINISH_REASONS,
  PET_ONBOARDING_NEW_RELATIONSHIP_MS,
  PET_ONBOARDING_PET_TYPE,
  PET_ONBOARDING_PRESENTATION_LEASE_MS,
  PET_ONBOARDING_SNOOZE_MS,
  PET_ONBOARDING_STATUS,
  PET_ONBOARDING_STEPS,
  PET_ONBOARDING_VERSION,
  ackPetOnboardingPresentation,
  calculatePetOnboardingEngagementSample,
  claimPetOnboardingPresentation,
  createPetOnboardingKey,
  createPetOnboardingState,
  dismissPetOnboarding,
  getNextPetOnboardingStep,
  isPetOnboardingContextEligible,
  isUuidV4,
  normalizePetOnboardingContext,
  normalizePetOnboardingState,
  readPetOnboardingEntry,
  recordPetOnboardingEngagement,
  recordPetOnboardingObservation,
  releasePetOnboardingPresentation,
  snoozePetOnboarding,
}
