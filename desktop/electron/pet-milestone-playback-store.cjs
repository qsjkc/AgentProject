const PLAYBACK_STATUSES = new Set(['claim', 'playing', 'ack_pending'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCanonicalUuid(value) {
  return typeof value === 'string'
    && value === value.trim()
    && UUID_PATTERN.test(value)
}

function isValidMilestone(value, petType, claimToken) {
  if (!isRecord(value)) {
    return false
  }

  const id = Number(value.id)
  const level = Number(value.level)
  return Boolean(
    Number.isInteger(id)
    && id > 0
    && (value.pet_type || petType) === petType
    && Number.isInteger(level)
    && level >= 2
    && level <= 5
    && isCanonicalUuid(value.claim_token)
    && value.claim_token === claimToken
  )
}

function isValidPetMilestonePlayback(value, petType = 'pig') {
  if (
    petType !== 'pig'
    || !isRecord(value)
    || (value.pet_type || petType) !== petType
    || !PLAYBACK_STATUSES.has(value.status)
    || !isCanonicalUuid(value.claim_token)
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || typeof value.displayed !== 'boolean'
  ) {
    return false
  }

  const hasMilestone = value.milestone !== null && value.milestone !== undefined
  if (hasMilestone && !isValidMilestone(value.milestone, petType, value.claim_token)) {
    return false
  }
  if (value.status !== 'claim' && !hasMilestone) {
    return false
  }
  if (value.status === 'ack_pending' && !value.displayed) {
    return false
  }
  return true
}

function inspectPetMilestonePlayback(playbackByPet, petType = 'pig') {
  const storeIsRecord = isRecord(playbackByPet)
  const normalizedPlaybackByPet = storeIsRecord ? playbackByPet : {}
  const hasEntry = Object.prototype.hasOwnProperty.call(normalizedPlaybackByPet, petType)
  const rawPlayback = hasEntry ? normalizedPlaybackByPet[petType] : null
  const current = isValidPetMilestonePlayback(rawPlayback, petType) ? rawPlayback : null
  return {
    playbackByPet: normalizedPlaybackByPet,
    current,
    currentRevision: current?.revision || 0,
    corrupted: !storeIsRecord || (hasEntry && !current),
  }
}

function withoutPetEntry(playbackByPet, petType) {
  const nextPlaybackByPet = { ...playbackByPet }
  delete nextPlaybackByPet[petType]
  return nextPlaybackByPet
}

function readPetMilestonePlaybackEntry(playbackByPet, petType = 'pig') {
  const snapshot = inspectPetMilestonePlayback(playbackByPet, petType)
  if (!snapshot.corrupted) {
    return {
      playback: snapshot.current,
      playbackByPet: snapshot.playbackByPet,
      changed: false,
    }
  }

  return {
    playback: null,
    playbackByPet: withoutPetEntry(snapshot.playbackByPet, petType),
    changed: true,
  }
}

function setPetMilestonePlaybackEntry({
  playbackByPet,
  petType = 'pig',
  playback,
  expectedRevision,
  updatedAt,
}) {
  const snapshot = inspectPetMilestonePlayback(playbackByPet, petType)
  if (!isValidPetMilestonePlayback(playback, petType)) {
    return { ok: false, reason: 'invalid-playback', current: snapshot.current }
  }
  if (
    !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || expectedRevision !== snapshot.currentRevision
    || playback.revision !== expectedRevision
  ) {
    return { ok: false, reason: 'revision-conflict', current: snapshot.current }
  }

  const nextPlayback = {
    ...playback,
    pet_type: petType,
    revision: snapshot.currentRevision + 1,
    updated_at: updatedAt,
  }
  return {
    ok: true,
    playback: nextPlayback,
    playbackByPet: {
      ...snapshot.playbackByPet,
      [petType]: nextPlayback,
    },
    recoveredCorruption: snapshot.corrupted,
  }
}

function clearPetMilestonePlaybackEntry({
  playbackByPet,
  petType = 'pig',
  claimToken = '',
  expectedRevision,
}) {
  const snapshot = inspectPetMilestonePlayback(playbackByPet, petType)
  if (snapshot.corrupted) {
    return {
      ok: true,
      playback: null,
      playbackByPet: withoutPetEntry(snapshot.playbackByPet, petType),
      changed: true,
      recoveredCorruption: true,
    }
  }
  if (!snapshot.current) {
    return {
      ok: true,
      playback: null,
      playbackByPet: snapshot.playbackByPet,
      changed: false,
    }
  }
  if (
    !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || expectedRevision !== snapshot.currentRevision
    || (claimToken && snapshot.current.claim_token !== claimToken)
  ) {
    return { ok: false, reason: 'revision-conflict', current: snapshot.current }
  }

  return {
    ok: true,
    playback: null,
    playbackByPet: withoutPetEntry(snapshot.playbackByPet, petType),
    changed: true,
  }
}

module.exports = {
  clearPetMilestonePlaybackEntry,
  isValidPetMilestonePlayback,
  readPetMilestonePlaybackEntry,
  setPetMilestonePlaybackEntry,
}
