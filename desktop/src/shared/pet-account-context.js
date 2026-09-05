function normalizePositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

export const AUTH_CONTEXT_CHANGED_CODE = 'AUTH_CONTEXT_CHANGED'

function normalizeSessionGeneration(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

export function normalizeSessionSnapshot(value) {
  if (!value || typeof value !== 'object') {
    return null
  }
  const token = typeof value.token === 'string' && value.token ? value.token : null
  const generation = normalizeSessionGeneration(value.generation)
  if (generation === null) {
    return null
  }
  return Object.freeze({ token, generation })
}

export function isSessionSnapshotCurrent(expected, current) {
  const normalizedExpected = normalizeSessionSnapshot(expected)
  const normalizedCurrent = normalizeSessionSnapshot(current)
  return Boolean(
    normalizedExpected
    && normalizedCurrent
    && normalizedExpected.token === normalizedCurrent.token
    && normalizedExpected.generation === normalizedCurrent.generation
  )
}

export function createSessionOperationContext(sessionSnapshot, values = {}) {
  const session = normalizeSessionSnapshot(sessionSnapshot)
  if (!session) {
    return null
  }
  if (
    Object.prototype.hasOwnProperty.call(values, 'session')
    && !isSessionSnapshotCurrent(values.session, session)
  ) {
    throw createAuthContextChangedError()
  }
  const { session: _untrustedSession, ...trustedValues } = values
  return Object.freeze({ ...trustedValues, session })
}

export function createLocalOperationContext(values = {}, scope = values.scope || 'pet') {
  const epoch = values.epoch
  return Object.freeze({
    scope: ['account', 'pet', 'relationship'].includes(scope) ? scope : 'pet',
    userId: normalizePositiveInteger(values.userId ?? values.user_id),
    petType: typeof (values.petType ?? values.pet_type) === 'string'
      ? (values.petType ?? values.pet_type)
      : null,
    relationshipId: normalizePositiveInteger(
      values.relationshipId ?? values.relationship_id ?? values.relationship?.id,
    ),
    accountEpoch: values.accountEpoch ?? epoch,
    petEpoch: values.petEpoch ?? epoch,
    relationshipEpoch: values.relationshipEpoch ?? epoch,
  })
}

export function createAuthContextChangedError() {
  const error = new Error('账户状态已变化，请重试。')
  error.code = AUTH_CONTEXT_CHANGED_CODE
  return error
}

export function isAuthContextChangedError(error) {
  return error?.code === AUTH_CONTEXT_CHANGED_CODE
}

export async function executeSessionBoundRequest({
  path,
  options = {},
  operationContext = null,
  getSessionSnapshot,
  requireApiBaseUrl,
  fetchImpl = fetch,
  clearSessionSnapshot,
  renewOperationContext,
  validateOperationContext,
}) {
  const initiatingSnapshot = normalizeSessionSnapshot(
    operationContext?.session ?? await getSessionSnapshot(),
  )
  if (!initiatingSnapshot) {
    throw createAuthContextChangedError()
  }
  if (!isSessionSnapshotCurrent(initiatingSnapshot, await getSessionSnapshot())) {
    throw createAuthContextChangedError()
  }
  const apiBaseUrl = await requireApiBaseUrl()
  const assertCurrent = async () => {
    if (!isSessionSnapshotCurrent(initiatingSnapshot, await getSessionSnapshot())) {
      throw createAuthContextChangedError()
    }
    if (
      operationContext?.authoritative
      && renewOperationContext
      && !await renewOperationContext(operationContext)
    ) {
      throw createAuthContextChangedError()
    }
    if (
      validateOperationContext
      && !await validateOperationContext(operationContext)
    ) {
      throw createAuthContextChangedError()
    }
  }
  await assertCurrent()

  const headers = new Headers(options.headers || {})
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  if (!headers.has('Content-Type') && !isFormData) {
    headers.set('Content-Type', 'application/json')
  }
  if (initiatingSnapshot.token) {
    headers.set('Authorization', `Bearer ${initiatingSnapshot.token}`)
  }

  const response = await fetchImpl(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  })
  await assertCurrent()
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: '请求失败' }))
    await assertCurrent()
    if (response.status === 401 || response.status === 403) {
      await clearSessionSnapshot?.(initiatingSnapshot).catch(() => undefined)
      throw new Error('登录已过期，请重新登录。')
    }
    const error = new Error(payload.detail || '请求失败')
    error.status = response.status
    error.detail = payload.detail
    throw error
  }
  if (response.status === 204) {
    return null
  }
  const payload = await response.json()
  await assertCurrent()
  return payload
}

export function createPetAccountContextKey({ hasSession, userId, petType } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId)
  if (!hasSession || normalizedUserId === null || typeof petType !== 'string' || !petType) {
    return null
  }
  return `${normalizedUserId}:${petType}`
}

export function deriveQuickChatPetStateContext(current = {}, payload = {}) {
  const nextPetType = payload.petType || current.petType || 'cat'
  const nextUserId = Object.prototype.hasOwnProperty.call(payload, 'userId')
    ? (normalizePositiveInteger(payload.userId))
    : (normalizePositiveInteger(current.userId))
  const nextHasSession = typeof payload.hasSession === 'boolean'
    ? payload.hasSession
    : Boolean(current.hasSession)
  const identityChanged = current.petType !== nextPetType
    || normalizePositiveInteger(current.userId) !== nextUserId
    || Boolean(current.hasSession) !== nextHasSession
  if (!identityChanged) {
    return { context: current, identityChanged: false, needsRecapture: false }
  }
  return {
    context: {
      hasSession: nextHasSession,
      petType: nextPetType,
      userId: nextUserId,
      session: null,
      authoritative: null,
    },
    identityChanged: true,
    needsRecapture: nextHasSession && nextUserId !== null,
  }
}

export function isPetAccountContextCurrent(expected, current) {
  const expectedKey = createPetAccountContextKey(expected)
  return expectedKey !== null && expectedKey === createPetAccountContextKey(current)
}

export function isPetAccountOperationCurrent(expected, current, { requireRelationship = false } = {}) {
  const operationScope = expected?.local?.scope || (requireRelationship ? 'relationship' : 'pet')
  const createKey = (value) => {
    if (!value || typeof value !== 'object' || value.hasSession === false) {
      return null
    }
    const semantic = value.local || value
    const userId = normalizePositiveInteger(semantic.userId ?? semantic.user_id)
    const petType = semantic.petType ?? semantic.pet_type
    const relationshipId = normalizePositiveInteger(
      semantic.relationshipId ?? semantic.relationship_id ?? semantic.relationship?.id,
    )
    if (
      userId === null
      || (operationScope !== 'account' && (typeof petType !== 'string' || !petType))
    ) {
      return null
    }
    if (operationScope === 'relationship' && relationshipId === null) {
      return null
    }
    if (operationScope === 'account') return String(userId)
    return operationScope === 'relationship'
      ? `${userId}:${relationshipId}:${petType}`
      : `${userId}:${petType}`
  }
  const expectedKey = createKey(expected)
  if (expectedKey === null || expectedKey !== createKey(current)) {
    return false
  }
  if (expected?.session) {
    if (!isSessionSnapshotCurrent(expected.session, current?.session)) {
      return false
    }
  }
  if (expected?.local) {
    const expectedLocal = expected.local
    const currentLocal = current?.local || current
    const epochMatches = (name) => (
      expectedLocal[name] === undefined
      || currentLocal?.[name] === undefined
      || expectedLocal[name] === currentLocal[name]
    )
    if (!epochMatches('accountEpoch')) return false
    if (operationScope !== 'account' && !epochMatches('petEpoch')) return false
    if (operationScope === 'relationship' && !epochMatches('relationshipEpoch')) return false
  }
  return true
}

export function createAccountOperationGate() {
  let requestEpoch = 0
  return {
    begin(context = {}) {
      requestEpoch += 1
      return Object.freeze({ ...context, requestEpoch })
    },
    invalidate() {
      requestEpoch += 1
      return requestEpoch
    },
    isCurrent(requestContext, currentContext) {
      if (
        !requestContext
        || requestContext.requestEpoch !== requestEpoch
        || !isPetAccountOperationCurrent(requestContext, currentContext)
      ) {
        return false
      }
      if (requestContext.session) {
        return isSessionSnapshotCurrent(requestContext.session, currentContext?.session)
      }
      return true
    },
  }
}

export function commitAccountOperation(gate, requestContext, currentContext, action) {
  if (!gate?.isCurrent?.(requestContext, currentContext)) {
    return false
  }
  action?.()
  return true
}

export async function runAccountOperation({
  gate,
  requestContext,
  getCurrentContext,
  operation,
  onSuccess,
  onError,
  onFinally,
}) {
  let stale = false
  let value
  let error = null
  try {
    value = await operation()
    stale = !commitAccountOperation(
      gate,
      requestContext,
      getCurrentContext?.(),
      () => onSuccess?.(value),
    )
  } catch (caughtError) {
    error = caughtError
    stale = !commitAccountOperation(
      gate,
      requestContext,
      getCurrentContext?.(),
      () => onError?.(caughtError),
    )
  } finally {
    const finallyCommitted = commitAccountOperation(
      gate,
      requestContext,
      getCurrentContext?.(),
      () => onFinally?.(),
    )
    stale = stale || !finallyCommitted
  }
  return { value, error, stale }
}

export function createRelationshipScopedRuntimeReset({ milestoneId = null } = {}) {
  return {
    relationship: null,
    equippedOutfit: null,
    previewOutfit: null,
    intimacyFeedback: '',
    transientBubble: '',
    companionState: 'reset',
    milestonePlayback: null,
    onboardingState: null,
    animationCompletion: { type: 'ANIMATION_DONE', milestoneId },
  }
}

export function createMainPanelRelationshipNullReset() {
  return {
    companionState: 'reset',
    petRelationshipLoading: false,
    petDailySummaryLoading: false,
    petOnboardingBusy: false,
    petOnboardingError: '',
    savingPet: false,
    savingOutfit: false,
    savingCompanionSettings: false,
  }
}

export function isPetRelationshipForAccountContext(relationship, context) {
  if (!relationship || typeof relationship !== 'object') {
    return false
  }
  const contextKey = createPetAccountContextKey(context)
  if (!contextKey) {
    return false
  }
  return createPetAccountContextKey({
    hasSession: true,
    userId: relationship.user_id ?? relationship.userId,
    petType: relationship.pet_type ?? relationship.petType,
  }) === contextKey
}

export async function adoptRelationshipCapability({
  payload,
  currentContext,
  validateCapability,
} = {}) {
  const relationship = payload?.relationship
  const semantic = payload?.semantic
  const authoritative = payload?.authoritative
  const userId = normalizePositiveInteger(relationship?.user_id ?? relationship?.userId)
  const relationshipId = normalizePositiveInteger(relationship?.id)
  const petType = relationship?.pet_type ?? relationship?.petType
  if (
    !authoritative?.id
    || userId === null
    || relationshipId === null
    || semantic?.userId !== userId
    || semantic?.petType !== petType
    || semantic?.relationshipId !== relationshipId
    || normalizePositiveInteger(currentContext?.userId) !== userId
    || currentContext?.petType !== petType
    || !await validateCapability?.(authoritative, 'relationship', semantic)
  ) return null
  return {
    relationship,
    authoritative,
    local: createLocalOperationContext({ userId, petType, relationshipId }, 'relationship'),
  }
}

export async function adoptPetStateCapability({ payload, currentContext, validateCapability } = {}) {
  const userId = normalizePositiveInteger(payload?.semantic?.userId)
  const petType = payload?.semantic?.petType
  if (
    !payload?.authoritative?.id
    || userId === null
    || payload?.userId !== userId
    || payload?.petType !== petType
    || normalizePositiveInteger(currentContext?.userId) !== userId
    || currentContext?.petType !== petType
    || !await validateCapability?.(payload.authoritative, 'pet', payload.semantic)
  ) return null
  return {
    authoritative: payload.authoritative,
    userId,
    petType,
    local: createLocalOperationContext({ userId, petType }, 'pet'),
  }
}

export function canCommitRelationshipReward({ cacheResult, expectedContext, currentContext } = {}) {
  return cacheResult?.ok === true
    && isPetAccountOperationCurrent(expectedContext, currentContext)
}
