export const PET_ONBOARDING_CAPABILITIES = Object.freeze({
  PET_INTERACTION: 'pet_interaction',
  RELATIONSHIP_VIEWED: 'relationship_viewed',
  REMINDER_CREATED: 'reminder_created',
  REMINDER_COMPLETED: 'reminder_completed',
})

export const PET_ONBOARDING_MAIN_PANEL_INTENT = 'pet-onboarding-relationship'

export function isPetOnboardingMainPanelIntent(value) {
  const intent = typeof value === 'string' ? value : value?.intent
  return intent === PET_ONBOARDING_MAIN_PANEL_INTENT
}

export const PET_ONBOARDING_SCENES = Object.freeze({
  RELATIONSHIP: 'relationship',
  REMINDER_OFFER: 'reminder_offer',
  REMINDER_WAITING: 'reminder_waiting',
})

const PET_ONBOARDING_VERSION = 1
const PET_ONBOARDING_STATUSES = Object.freeze(['active', 'finished', 'dismissed'])
const PET_ONBOARDING_MAIN_DTO_FIELDS = Object.freeze([
  'version',
  'user_id',
  'relationship_id',
  'pet_type',
  'status',
  'observed_capability_ids',
  'reminder_id',
  'snoozed_until',
  'revision',
])

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactMainDtoShape(value) {
  const actual = Object.keys(value).sort()
  const expected = [...PET_ONBOARDING_MAIN_DTO_FIELDS].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function normalizePetOnboardingMainStateResponse(value) {
  const candidate = value?.state ?? value
  if (
    !isPlainObject(candidate)
    || !hasExactMainDtoShape(candidate)
    || Number(candidate.version) !== PET_ONBOARDING_VERSION
  ) {
    return null
  }
  const userId = normalizePositiveInteger(candidate.user_id)
  const relationshipId = normalizePositiveInteger(candidate.relationship_id)
  const revision = normalizeNonNegativeInteger(candidate.revision)
  const reminderId = candidate.reminder_id === null || candidate.reminder_id === undefined
    ? null
    : normalizePositiveInteger(candidate.reminder_id)
  const snoozedUntil = normalizeTimestamp(candidate.snoozed_until)
  const observedCapabilityIds = normalizeCapabilityIds(candidate.observed_capability_ids)
    .filter((id) => Object.values(PET_ONBOARDING_CAPABILITIES).includes(id))
  if (
    userId === null
    || relationshipId === null
    || revision === null
    || candidate.pet_type !== 'pig'
    || !PET_ONBOARDING_STATUSES.includes(candidate.status)
    || !Array.isArray(candidate.observed_capability_ids)
    || (candidate.reminder_id !== null && candidate.reminder_id !== undefined && reminderId === null)
    || (candidate.snoozed_until && !snoozedUntil)
  ) {
    return null
  }
  return {
    version: PET_ONBOARDING_VERSION,
    user_id: userId,
    relationship_id: relationshipId,
    pet_type: 'pig',
    status: candidate.status,
    observed_capability_ids: observedCapabilityIds,
    reminder_id: reminderId,
    snoozed_until: candidate.status === 'active' ? snoozedUntil : null,
    revision,
  }
}

export function createPetOnboardingContextKey({ userId, relationshipId, petType }) {
  const normalizedUserId = normalizePositiveInteger(userId)
  const normalizedRelationshipId = normalizePositiveInteger(relationshipId)
  if (
    petType !== 'pig'
    || normalizedUserId === null
    || normalizedRelationshipId === null
  ) {
    return null
  }
  return `${normalizedUserId}:${normalizedRelationshipId}:pig`
}

export function isPetOnboardingStateForContext(state, context) {
  const expectedKey = createPetOnboardingContextKey(context)
  const stateKey = createPetOnboardingContextKey({
    userId: state?.user_id,
    relationshipId: state?.relationship_id,
    petType: state?.pet_type,
  })
  return expectedKey !== null && stateKey === expectedKey
}

export function selectPetOnboardingStateForContext(currentState, response, context) {
  const normalizedCurrent = normalizePetOnboardingMainStateResponse(currentState)
  const current = isPetOnboardingStateForContext(normalizedCurrent, context)
    ? normalizedCurrent
    : null
  const next = unwrapPetOnboardingStateResponse(response)
  if (!isPetOnboardingStateForContext(next, context)) {
    return current
  }

  const currentRevision = Number(current?.revision)
  const nextRevision = Number(next.revision)
  if (
    current
    && Number.isInteger(currentRevision)
    && Number.isInteger(nextRevision)
    && currentRevision > nextRevision
  ) {
    return current
  }
  return next
}

function normalizeCapabilityIds(value) {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

export function unwrapPetOnboardingStateResponse(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  if (Object.prototype.hasOwnProperty.call(value, 'ok')) {
    return value.ok === true ? normalizePetOnboardingMainStateResponse(value.state) : null
  }
  return normalizePetOnboardingMainStateResponse(value)
}

export function isPetOnboardingStateCurrent({
  authenticated,
  petType,
  userId,
  relationship,
  state,
  documentVisible,
  now = new Date(),
}) {
  if (
    !authenticated
    || petType !== 'pig'
    || !documentVisible
    || !relationship
    || relationship.pet_type !== 'pig'
    || !state
    || state.status !== 'active'
  ) {
    return false
  }

  const expectedUserId = normalizePositiveInteger(userId)
  const expectedRelationshipId = normalizePositiveInteger(relationship.id)
  if (
    expectedUserId === null
    || expectedRelationshipId === null
    || normalizePositiveInteger(relationship.user_id) !== expectedUserId
    || normalizePositiveInteger(state.user_id) !== expectedUserId
    || normalizePositiveInteger(state.relationship_id) !== expectedRelationshipId
  ) {
    return false
  }

  const snoozedValue = state.snoozed_until
  const snoozedUntil = Date.parse(snoozedValue || '')
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(nowMs)) {
    return false
  }
  return !snoozedValue || (Number.isFinite(snoozedUntil) && snoozedUntil <= nowMs)
}

export function derivePetOnboardingScene(state) {
  if (!state || state.status !== 'active') {
    return null
  }

  const observed = new Set(normalizeCapabilityIds(state.observed_capability_ids))
  if (
    normalizePositiveInteger(state.reminder_id) !== null
    && !observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED)
  ) {
    return PET_ONBOARDING_SCENES.REMINDER_WAITING
  }
  if (!observed.has(PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED)) {
    return PET_ONBOARDING_SCENES.RELATIONSHIP
  }
  if (!observed.has(PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED)) {
    return PET_ONBOARDING_SCENES.REMINDER_OFFER
  }
  return null
}

export function createPetOnboardingSampleReminderPayload(language, now = new Date()) {
  const baseTime = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(baseTime.getTime())) {
    throw new TypeError('A valid onboarding reminder time is required.')
  }

  const isChinese = language === 'zh-CN'
  return {
    pet_type: 'pig',
    title: isChinese ? '喝水' : 'Drink water',
    source_text: isChinese ? '1 分钟后提醒我喝水' : 'Remind me to drink water in 1 minute',
    remind_at: new Date(baseTime.getTime() + 60_000).toISOString(),
    recurrence_type: 'once',
    recurrence_timezone: null,
  }
}

export function isPetOnboardingReminderMatch(reminderId, expectedReminderId) {
  const reminder = normalizePositiveInteger(reminderId)
  const expected = normalizePositiveInteger(expectedReminderId)
  return reminder !== null && expected !== null && reminder === expected
}
