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

function isValidPetMilestonePlayback(
  value,
  petType = 'pig',
  { accountUserId = null, allowMissingAccountUserId = false } = {},
) {
  const normalizedAccountUserId = Number(accountUserId)
  const playbackAccountUserId = Number(value?.account_user_id)
  if (
    petType !== 'pig'
    || !isRecord(value)
    || (value.pet_type || petType) !== petType
    || !PLAYBACK_STATUSES.has(value.status)
    || !isCanonicalUuid(value.claim_token)
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || typeof value.displayed !== 'boolean'
    || (
      Number.isInteger(normalizedAccountUserId)
      && normalizedAccountUserId > 0
      && !(allowMissingAccountUserId && value.account_user_id === undefined)
      && playbackAccountUserId !== normalizedAccountUserId
    )
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

function inspectPetMilestonePlayback(
  playbackByPet,
  petType = 'pig',
  { storageKey = petType, accountUserId = null } = {},
) {
  const storeIsRecord = isRecord(playbackByPet)
  const normalizedPlaybackByPet = storeIsRecord ? playbackByPet : {}
  const hasEntry = Object.prototype.hasOwnProperty.call(normalizedPlaybackByPet, storageKey)
  const rawPlayback = hasEntry ? normalizedPlaybackByPet[storageKey] : null
  const current = isValidPetMilestonePlayback(rawPlayback, petType, { accountUserId }) ? rawPlayback : null
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

function readPetMilestonePlaybackEntry(playbackByPet, petType = 'pig', options = {}) {
  const snapshot = inspectPetMilestonePlayback(playbackByPet, petType, options)
  const storageKey = options.storageKey || petType
  let nextPlaybackByPet = snapshot.corrupted
    ? withoutPetEntry(snapshot.playbackByPet, storageKey)
    : snapshot.playbackByPet
  let playback = snapshot.corrupted ? null : snapshot.current
  let changed = snapshot.corrupted

  if (
    storageKey !== petType
    && Object.prototype.hasOwnProperty.call(nextPlaybackByPet, petType)
  ) {
    const legacyPlayback = nextPlaybackByPet[petType]
    nextPlaybackByPet = withoutPetEntry(nextPlaybackByPet, petType)
    changed = true
    const legacyAccountUserId = Number(legacyPlayback?.account_user_id)
    if (
      Number.isInteger(legacyAccountUserId)
      && legacyAccountUserId > 0
      && isValidPetMilestonePlayback(legacyPlayback, petType, {
        accountUserId: legacyAccountUserId,
      })
    ) {
      const isolatedStorageKey = `${legacyAccountUserId}:${petType}`
      if (!Object.prototype.hasOwnProperty.call(nextPlaybackByPet, isolatedStorageKey)) {
        nextPlaybackByPet = {
          ...nextPlaybackByPet,
          [isolatedStorageKey]: legacyPlayback,
        }
      }
      if (isolatedStorageKey === storageKey && !playback) {
        playback = nextPlaybackByPet[isolatedStorageKey]
      }
    }
  }

  return {
    playback,
    playbackByPet: nextPlaybackByPet,
    changed,
  }
}

function setPetMilestonePlaybackEntry({
  playbackByPet,
  petType = 'pig',
  storageKey = petType,
  accountUserId = null,
  playback,
  expectedRevision,
  updatedAt,
}) {
  const migrated = readPetMilestonePlaybackEntry(playbackByPet, petType, {
    storageKey,
    accountUserId,
  })
  const snapshot = inspectPetMilestonePlayback(migrated.playbackByPet, petType, {
    storageKey,
    accountUserId,
  })
  if (!isValidPetMilestonePlayback(playback, petType, {
    accountUserId,
    allowMissingAccountUserId: true,
  })) {
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
  if (Number.isInteger(Number(accountUserId)) && Number(accountUserId) > 0) {
    nextPlayback.account_user_id = Number(accountUserId)
  }
  return {
    ok: true,
    playback: nextPlayback,
    playbackByPet: {
      ...snapshot.playbackByPet,
      [storageKey]: nextPlayback,
    },
    recoveredCorruption: snapshot.corrupted || migrated.changed,
  }
}

function clearPetMilestonePlaybackEntry({
  playbackByPet,
  petType = 'pig',
  storageKey = petType,
  accountUserId = null,
  claimToken = '',
  expectedRevision,
}) {
  const migrated = readPetMilestonePlaybackEntry(playbackByPet, petType, {
    storageKey,
    accountUserId,
  })
  const snapshot = inspectPetMilestonePlayback(migrated.playbackByPet, petType, {
    storageKey,
    accountUserId,
  })
  if (snapshot.corrupted) {
    return {
      ok: true,
      playback: null,
      playbackByPet: withoutPetEntry(snapshot.playbackByPet, storageKey),
      changed: true,
      recoveredCorruption: true,
    }
  }
  if (!snapshot.current) {
    return {
      ok: true,
      playback: null,
      playbackByPet: snapshot.playbackByPet,
      changed: migrated.changed,
      recoveredCorruption: migrated.changed,
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
    playbackByPet: withoutPetEntry(snapshot.playbackByPet, storageKey),
    changed: true,
  }
}

function clearPetMilestonePlaybackSnapshot(options = {}) {
  const migrated = readPetMilestonePlaybackEntry(
    options.playbackByPet,
    options.petType,
    options,
  )
  const result = clearPetMilestonePlaybackEntry({
    ...options,
    playbackByPet: migrated.playbackByPet,
  })
  return result.playbackByPet
    ? result
    : { ...result, playbackByPet: migrated.playbackByPet, changed: migrated.changed }
}

module.exports = {
  clearPetMilestonePlaybackEntry,
  clearPetMilestonePlaybackSnapshot,
  isValidPetMilestonePlayback,
  readPetMilestonePlaybackEntry,
  setPetMilestonePlaybackEntry,
}
