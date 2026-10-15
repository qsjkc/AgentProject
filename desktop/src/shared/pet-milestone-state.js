export const PET_MILESTONE_PLAYBACK_STATUS = {
  CLAIM: 'claim',
  PLAYING: 'playing',
  ACK_PENDING: 'ack_pending',
}

const PLAYBACK_STATUSES = new Set(Object.values(PET_MILESTONE_PLAYBACK_STATUS))
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeMilestoneId(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

export function normalizePetRelationshipMilestone(value, fallbackPetType = 'pig') {
  if (!value || typeof value !== 'object') {
    return null
  }

  const id = normalizeMilestoneId(value.id)
  const level = Number(value.level)
  const claimToken = typeof value.claim_token === 'string' ? value.claim_token.trim() : ''
  const petType = value.pet_type || fallbackPetType
  if (
    !id
    || petType !== 'pig'
    || !Number.isInteger(level)
    || level < 2
    || level > 5
    || !UUID_PATTERN.test(claimToken)
  ) {
    return null
  }

  return {
    id,
    pet_type: petType,
    level,
    relationship_stage: value.relationship_stage || 'new_friend',
    reward_outfit_id: value.reward_outfit_id || null,
    achieved_at: value.achieved_at || null,
    claim_token: claimToken,
    claim_expires_at: value.claim_expires_at || null,
    acknowledged_at: value.acknowledged_at || null,
  }
}

export function createPetMilestoneClaimToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
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
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

export function createPetMilestonePlaybackState({
  petType = 'pig',
  status = PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
  claimToken,
  milestone = null,
  displayed = false,
  revision = 0,
} = {}) {
  const normalizedMilestone = normalizePetRelationshipMilestone(milestone, petType)
  const normalizedClaimToken = String(claimToken || normalizedMilestone?.claim_token || '').trim()
  const normalizedRevision = revision
  if (
    petType !== 'pig'
    || !UUID_PATTERN.test(normalizedClaimToken)
    || !PLAYBACK_STATUSES.has(status)
    || !Number.isInteger(normalizedRevision)
    || normalizedRevision < 0
  ) {
    return null
  }
  if (
    status !== PET_MILESTONE_PLAYBACK_STATUS.CLAIM
    && !normalizedMilestone
  ) {
    return null
  }
  if (
    normalizedMilestone
    && normalizedMilestone.claim_token !== normalizedClaimToken
  ) {
    return null
  }
  if (status === PET_MILESTONE_PLAYBACK_STATUS.ACK_PENDING && !displayed) {
    return null
  }

  return {
    pet_type: petType,
    status,
    claim_token: normalizedClaimToken,
    milestone: normalizedMilestone,
    displayed: Boolean(displayed),
    revision: normalizedRevision,
  }
}

export function normalizePetMilestonePlaybackState(value, fallbackPetType = 'pig') {
  if (!value || typeof value !== 'object') {
    return null
  }
  return createPetMilestonePlaybackState({
    petType: value.pet_type || fallbackPetType,
    status: value.status,
    claimToken: value.claim_token,
    milestone: value.milestone,
    displayed: value.displayed,
    revision: value.revision,
  })
}

export function getPetMilestonePersistenceConflict(response, fallbackPetType = 'pig') {
  if (response?.ok !== false || response?.reason !== 'revision-conflict') {
    return null
  }

  return {
    current: normalizePetMilestonePlaybackState(response.current, fallbackPetType),
  }
}

export function isPetMilestonePlaybackContextCurrent({
  expectedEpoch,
  currentEpoch,
  petType,
  hasSession,
}) {
  return Boolean(
    expectedEpoch === currentEpoch
    && petType === 'pig'
    && hasSession
  )
}

export function updatePetMilestonePlaybackStatus(value, status) {
  const current = normalizePetMilestonePlaybackState(value)
  if (!current) {
    return null
  }
  return createPetMilestonePlaybackState({
    petType: current.pet_type,
    status,
    claimToken: current.claim_token,
    milestone: current.milestone,
    displayed: current.displayed,
    revision: current.revision,
  })
}

export function isPetMilestoneClaimSafe({
  petType,
  hasSession,
  visibilityState,
  voicePhase,
  pointerActive,
  settlingPointer,
  activeCareAction,
  transientBubble,
  animationState,
  relationship,
}) {
  return Boolean(
    petType === 'pig'
    && hasSession
    && visibilityState === 'visible'
    && voicePhase === 'idle'
    && !pointerActive
    && !settlingPointer
    && !activeCareAction
    && !transientBubble
    && animationState?.action === 'idle'
    && !animationState?.locked
    && relationship?.pet_type === 'pig'
  )
}

export function isPetMilestonePlaybackSafe(context) {
  const { relationship, milestone } = context
  return Boolean(
    isPetMilestoneClaimSafe(context)
    && isPetRelationshipReadyForMilestone(relationship, milestone)
  )
}

export function isPetRelationshipReadyForMilestone(relationship, milestone) {
  return Boolean(
    relationship?.pet_type === 'pig'
    && milestone?.pet_type === 'pig'
    && Number.isInteger(Number(milestone.level))
    && Number(relationship.level) >= Number(milestone.level)
    && milestone.reward_outfit_id
    && relationship.outfit?.unlocked_outfit_ids?.includes(milestone.reward_outfit_id)
  )
}

export function isInvalidPetMilestoneClaimError(error) {
  return Number(error?.status) === 409
    || error?.detail === 'milestone_claim_invalid_or_expired'
    || error?.message === 'milestone_claim_invalid_or_expired'
}

export function isMissingPetRelationshipMilestoneError(error) {
  return Number(error?.status) === 404
    || error?.detail === 'milestone_not_found'
    || error?.message === 'milestone_not_found'
}
