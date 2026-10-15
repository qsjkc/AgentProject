function normalizePositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function normalizePetType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

function createStableAccountContextKey(value = {}, { requireRelationship = false } = {}) {
  if (!value || typeof value !== 'object' || value.hasSession === false) {
    return null
  }
  const userId = normalizePositiveInteger(value.userId ?? value.user_id)
  const petType = normalizePetType(value.petType ?? value.pet_type)
  const relationshipId = normalizePositiveInteger(
    value.relationshipId ?? value.relationship_id ?? value.relationship?.id,
  )
  if (userId === null || !petType || (requireRelationship && relationshipId === null)) {
    return null
  }
  return requireRelationship
    ? `${userId}:${relationshipId}:${petType}`
    : `${userId}:${petType}`
}

function isExactSessionSnapshot(expected, current) {
  return Boolean(
    expected
    && current
    && typeof expected === 'object'
    && typeof current === 'object'
    && typeof expected.token === 'string'
    && expected.token.length > 0
    && expected.token === current.token
    && Number.isInteger(expected.generation)
    && expected.generation >= 0
    && expected.generation === current.generation
  )
}

function isSameSessionSnapshot(expected, current) {
  return Boolean(
    expected
    && current
    && typeof expected === 'object'
    && typeof current === 'object'
    && (expected.token === null || typeof expected.token === 'string')
    && expected.token === current.token
    && Number.isInteger(expected.generation)
    && expected.generation >= 0
    && expected.generation === current.generation
  )
}

function createAuthoritativeOperationContextState({
  knownRoles = ['pet', 'quick-chat', 'main-panel'],
} = {}) {
  let observed = null
  let accountRevision = 0
  let petRevision = 0
  let relationshipRevision = 0

  const normalize = (value = {}) => ({
    session: value?.session && typeof value.session === 'object'
      ? {
          token: typeof value.session.token === 'string' && value.session.token
            ? value.session.token
            : null,
          generation: Number.isInteger(value.session.generation) && value.session.generation >= 0
            ? value.session.generation
            : -1,
        }
      : null,
    userId: normalizePositiveInteger(value?.userId ?? value?.user_id),
    petType: normalizePetType(value?.petType ?? value?.pet_type),
    relationshipId: normalizePositiveInteger(
      value?.relationshipId ?? value?.relationship_id ?? value?.relationship?.id,
    ),
  })
  const sameAccount = (left, right) => (
    isSameSessionSnapshot(left?.session, right?.session)
    && left?.userId === right?.userId
  )
  const samePet = (left, right) => (
    sameAccount(left, right)
    && left?.petType === right?.petType
  )
  const sameRelationship = (left, right) => (
    samePet(left, right)
    && left?.relationshipId === right?.relationshipId
  )

  const observe = (value, { forceRelationshipRevision = false } = {}) => {
    const next = normalize(value)
    if (observed) {
      const accountChanged = !sameAccount(observed, next)
      const petChanged = accountChanged || observed.petType !== next.petType
      const relationshipChanged = forceRelationshipRevision
        || petChanged
        || observed.relationshipId !== next.relationshipId
      if (accountChanged) accountRevision += 1
      if (petChanged) petRevision += 1
      if (relationshipChanged) relationshipRevision += 1
    }
    observed = next
    return next
  }

  const capture = (value, scope = 'pet') => {
    const current = observe(value)
    return Object.freeze({
      scope: ['account', 'pet', 'relationship'].includes(scope) ? scope : 'pet',
      session: Object.freeze({ ...current.session }),
      userId: current.userId,
      petType: current.petType,
      relationshipId: current.relationshipId,
      accountRevision,
      petRevision,
      relationshipRevision,
    })
  }

  const validate = (snapshot, value, requiredScope = snapshot?.scope) => {
    if (!snapshot || !observed) return false
    const current = normalize(value)
    if (
      !sameAccount(snapshot, current)
      || snapshot.accountRevision !== accountRevision
    ) {
      return false
    }
    if (requiredScope === 'account') return true
    if (!samePet(snapshot, current) || snapshot.petRevision !== petRevision) return false
    if (requiredScope === 'pet') return true
    return sameRelationship(snapshot, current)
      && snapshot.relationshipRevision === relationshipRevision
  }

  const captureForRole = (senderRole, value, scope = 'pet', expected = null) => {
    if (!knownRoles.includes(senderRole)) return null
    const current = normalize(value)
    if (expected) {
      if (expected.authoritative && !validate(expected.authoritative, value)) {
        return null
      }
      const expectedValue = normalize(expected)
      const matches = scope === 'account'
        ? sameAccount(expectedValue, current)
        : scope === 'relationship'
          ? sameRelationship(expectedValue, current)
          : samePet(expectedValue, current)
      if (!matches) return null
    }
    return capture(value, scope)
  }

  return { capture, captureForRole, observe, validate }
}

const OPERATION_SCOPE_RANK = Object.freeze({ account: 1, pet: 2, relationship: 3 })

function createOperationCapabilityRegistry({
  authoritativeState,
  now = Date.now,
  ttlMs = 30000,
  createId,
  maxPerSender = 32,
} = {}) {
  const capabilities = new Map()
  const capabilitiesBySender = new Map()
  const rendererInstancesBySender = new Map()
  const activeCapabilityBySender = new Map()
  const allowedScopes = {
    'main-panel': new Set(['account', 'pet', 'relationship']),
    pet: new Set(['pet', 'relationship']),
    'quick-chat': new Set(['pet', 'relationship']),
  }
  const boundedTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : 30000
  const boundedMaxPerSender = Number.isInteger(Number(maxPerSender)) && Number(maxPerSender) > 0
    ? Number(maxPerSender)
    : 32

  const cleanupExpired = () => {
    // Expired entries remain renewable while their internal snapshot is still current.
    // Per-sender LRU bounds memory; context/session/window transitions revoke entries.
    return 0
  }

  const remove = (id) => {
    const entry = capabilities.get(id)
    if (!entry) return false
    capabilities.delete(id)
    const senderEntries = capabilitiesBySender.get(entry.sender)
    senderEntries?.delete(id)
    if (senderEntries?.size === 0) capabilitiesBySender.delete(entry.sender)
    if (activeCapabilityBySender.get(entry.sender) === id) {
      activeCapabilityBySender.delete(entry.sender)
    }
    return true
  }

  const touch = (entry, { pin = false } = {}) => {
    let senderEntries = capabilitiesBySender.get(entry.sender)
    if (!senderEntries) {
      senderEntries = new Map()
      capabilitiesBySender.set(entry.sender, senderEntries)
    }
    senderEntries.delete(entry.id)
    senderEntries.set(entry.id, true)
    if (pin) activeCapabilityBySender.set(entry.sender, entry.id)
    while (senderEntries.size > boundedMaxPerSender) {
      const activeId = activeCapabilityBySender.get(entry.sender)
      const evictableId = [...senderEntries.keys()].find((id) => id !== activeId)
      if (!evictableId) {
        if (activeId !== entry.id) remove(entry.id)
        return false
      }
      remove(evictableId)
    }
    return capabilities.has(entry.id)
  }

  const getRendererInstanceNonce = (sender) => rendererInstancesBySender.get(sender)?.nonce || null

  const isRendererInstanceCurrent = ({ sender, senderRole, rendererInstanceNonce } = {}) => {
    const instance = rendererInstancesBySender.get(sender)
    return Boolean(
      instance
      && instance.senderRole === senderRole
      && typeof rendererInstanceNonce === 'string'
      && rendererInstanceNonce
      && instance.nonce === rendererInstanceNonce
    )
  }

  const registerRendererInstance = ({ sender, senderRole, rendererInstanceNonce } = {}) => {
    if (
      !sender
      || !allowedScopes[senderRole]
      || typeof rendererInstanceNonce !== 'string'
      || !rendererInstanceNonce
    ) return false
    const existing = rendererInstancesBySender.get(sender)
    if (existing?.senderRole === senderRole && existing.nonce === rendererInstanceNonce) {
      return true
    }
    if (existing) {
      for (const [id, entry] of capabilities) {
        if (entry.sender === sender) remove(id)
      }
      activeCapabilityBySender.delete(sender)
    }
    rendererInstancesBySender.set(sender, {
      senderRole,
      nonce: rendererInstanceNonce,
      hasCaptured: false,
    })
    return true
  }

  const semanticMatches = (snapshot, scope, semantic) => Boolean(
    semantic
    && normalizePositiveInteger(semantic.userId) === snapshot.userId
    && (scope === 'account' || normalizePetType(semantic.petType) === snapshot.petType)
    && (
      scope !== 'relationship'
      || normalizePositiveInteger(semantic.relationshipId) === snapshot.relationshipId
    )
  )

  const issueInternal = ({
    sender,
    senderRole,
    scope,
    currentContext,
    expectedContext = null,
    trustedNew = false,
    rendererInstanceNonce = null,
    pin = !trustedNew,
  } = {}) => {
    const registeredInstance = rendererInstancesBySender.get(sender)
    const effectiveRendererInstanceNonce = rendererInstanceNonce || (
      trustedNew ? registeredInstance?.nonce : null
    )
    if (
      !sender
      || !allowedScopes[senderRole]?.has(scope)
      || currentContext?.hasSession !== true
      || normalizePositiveInteger(currentContext?.userId ?? currentContext?.user_id) === null
      || !currentContext?.session?.token
      || !Number.isInteger(currentContext?.session?.generation)
      || (scope === 'relationship'
        && normalizePositiveInteger(
          currentContext?.relationshipId ?? currentContext?.relationship_id,
        ) === null)
      || (registeredInstance && !isRendererInstanceCurrent({
        sender,
        senderRole,
        rendererInstanceNonce: effectiveRendererInstanceNonce,
      }))
    ) {
      return null
    }
    const existingId = expectedContext?.authoritative?.id
    if (existingId) {
      return renew({
        sender,
        senderRole,
        rendererInstanceNonce: effectiveRendererInstanceNonce,
        capability: expectedContext.authoritative,
        requiredScope: scope,
        currentContext,
        expectedSemantic: expectedContext,
      })
    }
    if (!trustedNew && registeredInstance?.hasCaptured) {
      return null
    }
    const rendererExpectedContext = expectedContext
      ? { ...expectedContext, authoritative: null }
      : null
    const requestedSnapshot = authoritativeState?.captureForRole?.(
      senderRole,
      currentContext,
      scope,
      rendererExpectedContext,
    )
    if (!requestedSnapshot) return null
    const id = createId?.()
    if (typeof id !== 'string' || !id) return null
    const expiresAt = Number(now()) + boundedTtlMs
    const entry = {
      id,
      sender,
      senderRole,
      rendererInstanceNonce: effectiveRendererInstanceNonce,
      scope,
      snapshot: requestedSnapshot,
      expiresAt,
    }
    capabilities.set(id, entry)
    if (!touch(entry, { pin })) return null
    if (!trustedNew && registeredInstance) registeredInstance.hasCaptured = true
    return Object.freeze({ id })
  }

  const issue = (options = {}) => issueInternal(options)
  const issueTrusted = (options = {}) => issueInternal({ ...options, trustedNew: true })

  function renew({
    sender,
    senderRole,
    rendererInstanceNonce,
    capability,
    requiredScope,
    currentContext,
    expectedSemantic,
  } = {}) {
    const entry = capability?.id ? capabilities.get(capability.id) : null
    if (!entry || entry.sender !== sender || entry.senderRole !== senderRole) return null
    const registeredInstance = rendererInstancesBySender.get(sender)
    if (
      registeredInstance
      && !isRendererInstanceCurrent({ sender, senderRole, rendererInstanceNonce })
    ) return null
    if (
      entry.rendererInstanceNonce
      && entry.rendererInstanceNonce !== (rendererInstanceNonce || registeredInstance?.nonce)
    ) return null
    const requestedRank = OPERATION_SCOPE_RANK[requiredScope]
    if (!requestedRank) return null
    const entryRank = OPERATION_SCOPE_RANK[entry.scope]
    if (requestedRank < entryRank) {
      if (!allowedScopes[senderRole]?.has(requiredScope)) return null
      if (!authoritativeState?.validate?.(entry.snapshot, currentContext, requiredScope)) {
        return null
      }
      if (!semanticMatches(entry.snapshot, requiredScope, expectedSemantic)) return null
      return issueInternal({
        sender,
        senderRole,
        scope: requiredScope,
        currentContext,
        trustedNew: true,
        rendererInstanceNonce: rendererInstanceNonce || registeredInstance?.nonce,
        pin: true,
      })
    }
    const effectiveScope = requestedRank > entryRank
      ? requiredScope
      : entry.scope
    if (!allowedScopes[senderRole]?.has(effectiveScope)) return null
    if (!authoritativeState?.validate?.(entry.snapshot, currentContext, entry.scope)) return null
    let snapshot = entry.snapshot
    if (effectiveScope !== entry.scope) {
      snapshot = authoritativeState?.capture?.(currentContext, effectiveScope)
      if (!snapshot) return null
    }
    if (!semanticMatches(snapshot, effectiveScope, expectedSemantic)) return null
    entry.scope = effectiveScope
    entry.snapshot = snapshot
    entry.expiresAt = Number(now()) + boundedTtlMs
    if (!touch(entry, { pin: true })) return null
    return Object.freeze({ id: entry.id })
  }

  const authorize = ({
    sender,
    senderRole,
    capability,
    requiredScope,
    currentContext,
    expectedSemantic,
  } = {}) => {
    if (!capability?.id) return { ok: false, reason: 'capability-required' }
    const entry = capabilities.get(capability.id)
    if (!entry) return { ok: false, reason: 'capability-not-found' }
    if (entry.expiresAt <= Number(now())) {
      return { ok: false, reason: 'capability-expired' }
    }
    if (entry.sender !== sender || entry.senderRole !== senderRole) {
      return { ok: false, reason: 'capability-sender-mismatch' }
    }
    if (
      !OPERATION_SCOPE_RANK[requiredScope]
      || OPERATION_SCOPE_RANK[entry.scope] < OPERATION_SCOPE_RANK[requiredScope]
    ) {
      return { ok: false, reason: 'capability-scope-mismatch' }
    }
    if (!authoritativeState?.validate?.(entry.snapshot, currentContext, requiredScope)) {
      return { ok: false, reason: 'capability-context-changed' }
    }
    if (expectedSemantic) {
      if (normalizePositiveInteger(expectedSemantic.userId) !== entry.snapshot.userId) {
        return { ok: false, reason: 'capability-semantic-mismatch' }
      }
      if (
        requiredScope !== 'account'
        && normalizePetType(expectedSemantic.petType) !== entry.snapshot.petType
      ) return { ok: false, reason: 'capability-semantic-mismatch' }
      if (
        requiredScope === 'relationship'
        && normalizePositiveInteger(expectedSemantic.relationshipId) !== entry.snapshot.relationshipId
      ) return { ok: false, reason: 'capability-semantic-mismatch' }
    }
    touch(entry)
    return { ok: true, scope: entry.scope }
  }

  const revokeSender = (sender) => {
    let count = 0
    for (const [id, entry] of capabilities) {
      if (entry.sender === sender) {
        remove(id)
        count += 1
      }
    }
    activeCapabilityBySender.delete(sender)
    rendererInstancesBySender.delete(sender)
    return count
  }

  const validate = ({
    sender,
    senderRole,
    rendererInstanceNonce,
    capability,
    currentContext,
    expectedSemantic,
  } = {}) => {
    if (
      rendererInstancesBySender.has(sender)
      && !isRendererInstanceCurrent({ sender, senderRole, rendererInstanceNonce })
    ) return { ok: false, reason: 'renderer-instance-mismatch' }
    const entry = capability?.id ? capabilities.get(capability.id) : null
    return authorize({
      sender,
      senderRole,
      capability,
      requiredScope: entry?.scope,
      currentContext,
      expectedSemantic,
    })
  }

  const transition = ({
    sender,
    senderRole,
    capability,
    requiredScope,
    currentContext,
    nextScope,
    apply,
    getCurrentContext,
  } = {}) => {
    const authorization = authorize({
      sender,
      senderRole,
      capability,
      requiredScope,
      currentContext,
    })
    if (!authorization.ok) return authorization
    const value = apply?.()
    remove(capability.id)
    const nextCapability = issueInternal({
      sender,
      senderRole,
      scope: nextScope,
      currentContext: getCurrentContext?.(),
      trustedNew: true,
      rendererInstanceNonce: getRendererInstanceNonce(sender),
      pin: true,
    })
    if (!nextCapability) {
      return { ok: false, reason: 'post-write-capability-unavailable' }
    }
    return { ok: true, value, capability: nextCapability }
  }

  const revokeAll = () => {
    const count = capabilities.size
    capabilities.clear()
    capabilitiesBySender.clear()
    activeCapabilityBySender.clear()
    rendererInstancesBySender.clear()
    return count
  }

  const resetCapabilities = () => {
    const count = capabilities.size
    capabilities.clear()
    capabilitiesBySender.clear()
    activeCapabilityBySender.clear()
    for (const instance of rendererInstancesBySender.values()) {
      instance.hasCaptured = false
    }
    return count
  }

  const expireAll = () => {
    const expiredAt = Number(now()) - 1
    for (const entry of capabilities.values()) {
      entry.expiresAt = expiredAt
    }
    return capabilities.size
  }

  const sizeForSender = (sender) => capabilitiesBySender.get(sender)?.size || 0

  return {
    authorize,
    cleanupExpired,
    expireAll,
    issue,
    issueTrusted,
    getRendererInstanceNonce,
    isRendererInstanceCurrent,
    registerRendererInstance,
    renew,
    resetCapabilities,
    revokeAll,
    revokeSender,
    sizeForSender,
    transition,
    validate,
  }
}

function createRuntimeStateForRole({ role, runtimeState } = {}) {
  if (!['pet', 'quick-chat', 'main-panel'].includes(role) || !runtimeState) return null
  const state = runtimeState.petState || {}
  return {
    petState: {
      hasSession: Boolean(state.hasSession),
      userId: normalizePositiveInteger(state.userId),
      petType: normalizePetType(state.petType) || 'cat',
    },
    voiceSettings: runtimeState.voiceSettings || {},
    companionSettings: runtimeState.companionSettings || {},
    voiceGlobalShortcut: runtimeState.voiceGlobalShortcut || { registered: false },
    windows: runtimeState.windows || {},
  }
}

function createRelationshipBroadcastOrchestrator({
  getCurrentRelationship,
  getCurrentContext,
  issueCapability,
  send,
} = {}) {
  const emit = (target) => {
    const relationship = getCurrentRelationship?.()
    if (!relationship) return null
    const semantic = {
      userId: normalizePositiveInteger(relationship.user_id ?? relationship.userId),
      petType: normalizePetType(relationship.pet_type ?? relationship.petType),
      relationshipId: normalizePositiveInteger(relationship.id),
    }
    if (!semantic.userId || !semantic.petType || !semantic.relationshipId) return null
    const currentContext = getCurrentContext?.()
    if (
      normalizePositiveInteger(currentContext?.userId) !== semantic.userId
      || normalizePetType(currentContext?.petType) !== semantic.petType
      || normalizePositiveInteger(currentContext?.relationshipId) !== semantic.relationshipId
    ) return null
    const authoritative = issueCapability?.({ target, currentContext })
    if (!authoritative?.id) return null
    const payload = { relationship, semantic, authoritative }
    send?.(target, payload)
    return payload
  }
  return {
    emit,
    createDeferredEmit: (target) => () => emit(target),
  }
}

function authorizeSessionClear({ senderRole, expectedSession, currentSession } = {}) {
  if (!['pet', 'quick-chat', 'main-panel'].includes(senderRole)) {
    return false
  }
  if (expectedSession === undefined || expectedSession === null) {
    return senderRole === 'main-panel'
  }
  return isExactSessionSnapshot(expectedSession, currentSession)
}

function authorizeNotification({
  senderRole,
  expectedContext,
  currentContext,
  validate,
} = {}) {
  if (senderRole === 'main-panel' && !expectedContext) {
    return true
  }
  return senderRole === 'pet'
    && Boolean(expectedContext)
    && typeof validate === 'function'
    && validate(expectedContext, currentContext) === true
}

function authorizeSwitchPet({
  senderRole,
  expectedUserId,
  currentSessionSubject,
  activeUserId,
  expectedSession,
  currentSession,
  expectedFromPet,
  currentPet,
} = {}) {
  if (senderRole !== 'main-panel') {
    return { ok: false, reason: 'forbidden' }
  }
  const expected = normalizePositiveInteger(expectedUserId)
  const subject = normalizePositiveInteger(currentSessionSubject)
  const active = normalizePositiveInteger(activeUserId)
  if (expected === null || subject === null || expected !== subject || active !== subject) {
    return { ok: false, reason: 'identity-mismatch' }
  }
  if (!isExactSessionSnapshot(expectedSession, currentSession)) {
    return { ok: false, reason: 'session-mismatch' }
  }
  if (
    normalizePetType(expectedFromPet) === null
    || normalizePetType(expectedFromPet) !== normalizePetType(currentPet)
  ) {
    return { ok: false, reason: 'pet-mismatch' }
  }
  return { ok: true }
}

function authorizeAccountMutation({
  senderRole,
  allowedRoles,
  expectedContext,
  currentContext,
  requireRelationship = false,
} = {}) {
  if (!Array.isArray(allowedRoles) || !allowedRoles.includes(senderRole)) {
    return { ok: false, reason: 'forbidden' }
  }
  const expectedKey = createStableAccountContextKey(expectedContext, { requireRelationship })
  const currentKey = createStableAccountContextKey(currentContext, { requireRelationship })
  if (!expectedKey || expectedKey !== currentKey) {
    return { ok: false, reason: 'account-mismatch' }
  }
  if (!isExactSessionSnapshot(expectedContext?.session, currentContext?.session)) {
    return { ok: false, reason: 'session-mismatch' }
  }
  return { ok: true }
}

module.exports = {
  authorizeAccountMutation,
  authorizeNotification,
  authorizeSessionClear,
  authorizeSwitchPet,
  createStableAccountContextKey,
  createAuthoritativeOperationContextState,
  createOperationCapabilityRegistry,
  createRelationshipBroadcastOrchestrator,
  createRuntimeStateForRole,
  isExactSessionSnapshot,
  normalizePositiveInteger,
}
