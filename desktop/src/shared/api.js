import { normalizeApiBaseUrl } from './api-base-url'
import { runWithRequestDeadline } from './request-deadline'
import { formatApiErrorDetail } from './api-error'
import {
  createAuthContextChangedError,
  createLocalOperationContext,
  createSessionOperationContext,
  executeSessionBoundRequest,
  isSessionSnapshotCurrent,
  normalizeSessionSnapshot,
} from './pet-account-context'

const LOCAL_API_BASE_URL = 'http://127.0.0.1:5000/api/v1'

const buildTimeApiBaseUrl = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL || __DETACHYM_DEFAULT_API_BASE_URL__ || '',
)
let cachedApiBaseUrl = import.meta.env.DEV ? LOCAL_API_BASE_URL : buildTimeApiBaseUrl
let latestOperationCapability = null
let latestOperationSession = null

function getDesktopBridge() {
  return window.desktopBridge || null
}

function getUnconfiguredServerMessage() {
  return import.meta.env.DEV
    ? '未检测到桌面端服务，请先启动本地后端或配置服务地址。'
    : '请先配置服务地址，再使用桌面客户端。'
}

function withLocalOperationContext(operationContext) {
  if (!operationContext || operationContext.local) return operationContext
  const inferredScope = operationContext.relationshipId ?? operationContext.relationship_id
    ? 'relationship'
    : operationContext.petType ?? operationContext.pet_type
      ? 'pet'
      : 'account'
  return {
    ...operationContext,
    local: createLocalOperationContext(operationContext, inferredScope),
  }
}

async function requireApiBaseUrl() {
  const apiBaseUrl = await getApiBaseUrl()
  if (!apiBaseUrl) {
    throw new Error(getUnconfiguredServerMessage())
  }
  return apiBaseUrl
}

export async function getApiBaseUrl() {
  const bridge = getDesktopBridge()
  const storedApiBaseUrl = normalizeApiBaseUrl(await bridge?.getApiBaseUrl?.())
  if (storedApiBaseUrl) {
    cachedApiBaseUrl = storedApiBaseUrl
    return storedApiBaseUrl
  }

  return cachedApiBaseUrl
}

export async function beginLoginAttempt(value) {
  const server = normalizeApiBaseUrl(value)
  if (!server) throw new Error(getUnconfiguredServerMessage())
  const attempt = await getDesktopBridge()?.beginLoginAttempt?.(server)
  if (!attempt) throw createAuthContextChangedError()
  return attempt
}

export async function cancelLoginAttempt(attempt) {
  return getDesktopBridge()?.cancelLoginAttempt?.(attempt)
}

export async function setApiBaseUrl(value, attempt) {
  const normalizedValue = normalizeApiBaseUrl(value)
  const bridge = getDesktopBridge()
  const saved = await bridge?.setApiBaseUrl?.(normalizedValue, attempt)
  if (saved !== normalizedValue) throw createAuthContextChangedError()
  cachedApiBaseUrl = normalizedValue
  return normalizedValue
}

export async function getLanguage() {
  return getDesktopBridge()?.getLanguage?.()
}

export async function setLanguage(value) {
  return getDesktopBridge()?.setLanguage?.(value)
}

export async function getVoiceSettings() {
  return getDesktopBridge()?.getVoiceSettings?.()
}

export async function updateVoiceSettings(patch) {
  return getDesktopBridge()?.updateVoiceSettings?.(patch)
}

export async function getCompanionSettings() {
  return getDesktopBridge()?.getCompanionSettings?.()
}

export async function updateCompanionSettings(patch) {
  return getDesktopBridge()?.updateCompanionSettings?.(patch)
}

export async function openQuickChat() {
  return getDesktopBridge()?.openQuickChat?.()
}

export async function hideQuickChat() {
  return getDesktopBridge()?.hideQuickChat?.()
}

export async function checkApiConnection(value, { signal } = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(value)
  if (!apiBaseUrl) {
    throw new Error(getUnconfiguredServerMessage())
  }

  const response = await runWithRequestDeadline((requestSignal) => (
    fetch(`${apiBaseUrl}/public/version/win-x64`, { signal: requestSignal })
  ), { signal })
  if (!response.ok) {
    throw new Error('无法连接到 Detachym 服务。')
  }

  return apiBaseUrl
}

export async function getSessionToken() {
  return getDesktopBridge()?.getSessionToken?.()
}

export async function getSessionSnapshot() {
  return getDesktopBridge()?.getSessionSnapshot?.()
}

export async function captureApiOperationContext(values = {}, scope = 'pet') {
  const bridge = getDesktopBridge()
  const initiatingSession = normalizeSessionSnapshot(values?.session ?? await getSessionSnapshot())
  if (!initiatingSession || !isSessionSnapshotCurrent(initiatingSession, await getSessionSnapshot())) {
    throw createAuthContextChangedError()
  }
  if (!isSessionSnapshotCurrent(latestOperationSession, initiatingSession)) {
    latestOperationCapability = null
    latestOperationSession = initiatingSession
  }
  const petState = await bridge?.getPetState?.()
  const semanticValues = {
    ...values,
    hasSession: true,
    userId: values.userId ?? values.user_id ?? petState?.userId ?? null,
    petType: values.petType ?? values.pet_type ?? petState?.petType ?? null,
    relationshipId: values.relationshipId ?? values.relationship_id ?? null,
  }
  const local = createLocalOperationContext(semanticValues, scope)
  const initiatingCapability = values.authoritative ?? latestOperationCapability
  const semantic = { ...semanticValues, session: initiatingSession, ...local }
  const authoritative = initiatingCapability
    ? await bridge?.renewOperationContext?.(initiatingCapability, scope, semantic)
    : await bridge?.captureOperationContext?.(scope, semantic)
  if ((bridge?.captureOperationContext || bridge?.renewOperationContext) && !authoritative) {
    throw createAuthContextChangedError()
  }
  latestOperationCapability = authoritative ?? initiatingCapability ?? null
  latestOperationSession = initiatingSession
  return createSessionOperationContext(initiatingSession, {
    ...semanticValues,
    authoritative: authoritative ?? values?.authoritative ?? null,
    local,
  })
}

export async function assertApiOperationContextCurrent(operationContext) {
  let effectiveContext = withLocalOperationContext(operationContext)
  if (
    !effectiveContext?.session
    || !isSessionSnapshotCurrent(effectiveContext.session, await getSessionSnapshot())
  ) {
    throw createAuthContextChangedError()
  }
  if (effectiveContext.authoritative) {
    const renewed = await getDesktopBridge()?.renewOperationContext?.(
      effectiveContext.authoritative,
      effectiveContext.local.scope,
      effectiveContext.local,
    )
    if (!renewed) throw createAuthContextChangedError()
    effectiveContext = { ...effectiveContext, authoritative: renewed }
    if (!await getDesktopBridge()?.validateOperationContext?.(
      effectiveContext.authoritative,
      effectiveContext.local.scope,
      effectiveContext.local,
    )) throw createAuthContextChangedError()
  }
  return true
}

export async function setSessionToken(token, attempt) {
  const result = await getDesktopBridge()?.setSessionToken?.(token, attempt)
  if (result) {
    latestOperationCapability = null
    latestOperationSession = null
  }
  return result
}

export async function clearSessionToken(expectedSession) {
  const result = await getDesktopBridge()?.clearSessionToken?.(expectedSession)
  if (result) {
    latestOperationCapability = null
    latestOperationSession = null
  }
  return result
}

async function request(path, options = {}, operationContext = null) {
  const effectiveContext = withLocalOperationContext(operationContext)
  const assertServer = (apiBaseUrl) => {
    if (effectiveContext?.server === undefined) return
    const expected = normalizeApiBaseUrl(effectiveContext.server)
    if (!expected || expected !== apiBaseUrl) throw createAuthContextChangedError()
  }
  const result = await executeSessionBoundRequest({
    path,
    options,
    operationContext: effectiveContext,
    getSessionSnapshot,
    requireApiBaseUrl: async () => {
      const apiBaseUrl = await requireApiBaseUrl()
      assertServer(apiBaseUrl)
      return apiBaseUrl
    },
    fetchImpl: fetch,
    timeoutMs: path === '/chat/message' || path === '/rag/upload' ? 120_000 : undefined,
    clearSessionSnapshot: clearSessionToken,
    renewOperationContext: async (context) => (
      !context?.authoritative
      || await getDesktopBridge()?.renewOperationContext?.(
        context.authoritative,
        context.local?.scope || 'pet',
        context.local,
      )
    ),
    validateOperationContext: async (context) => {
      if (effectiveContext?.server !== undefined) assertServer(await getApiBaseUrl())
      const authorized = !context?.authoritative || Boolean(await getDesktopBridge()?.validateOperationContext?.(
        context.authoritative,
        context.local?.scope || 'pet',
        context.local,
      ))
      if (effectiveContext?.server !== undefined) assertServer(await getApiBaseUrl())
      return authorized
    },
  })
  await getDesktopBridge()?.e2e?.recordRequestCompletion?.({
    path,
    ok: true,
    userId: effectiveContext?.local?.userId ?? effectiveContext?.userId,
  })
  return result
}

export const desktopApiRequest = request

export async function login(username, password, { attempt, isCurrent = () => true, signal } = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(attempt?.server)
  const expectedSession = normalizeSessionSnapshot(attempt?.session)
  const assertCurrent = async () => {
    if (!attempt?.id || !apiBaseUrl || !expectedSession || !isCurrent()) throw createAuthContextChangedError()
    const [currentServer, currentSession] = await Promise.all([getApiBaseUrl(), getSessionSnapshot()])
    if (!isCurrent() || currentServer !== apiBaseUrl || !isSessionSnapshotCurrent(expectedSession, currentSession)) {
      throw createAuthContextChangedError()
    }
  }
  await assertCurrent()
  const formData = new FormData()
  formData.append('username', username)
  formData.append('password', password)

  const data = await runWithRequestDeadline(async (requestSignal) => {
    if (!isCurrent()) throw createAuthContextChangedError()
    const response = await fetch(`${apiBaseUrl}/auth/login`, {
      method: 'POST',
      body: formData,
      cache: 'no-store',
      signal: requestSignal,
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ detail: '登录失败' }))
      throw new Error(formatApiErrorDetail(payload.detail, '登录失败'))
    }

    return response.json()
  }, { signal })
  await assertCurrent()
  const committedSession = normalizeSessionSnapshot(await setSessionToken(data.access_token, attempt))
  if (!committedSession || committedSession.token !== data.access_token || !isCurrent()) throw createAuthContextChangedError()
  return { ...data, session: committedSession, server: apiBaseUrl }
}

export const desktopApi = {
  me: (operationContext) => request('/auth/me', {}, operationContext),
  getPreferences: (operationContext) => request('/users/me/preferences', {}, operationContext),
  updatePreferences: (payload, operationContext) =>
    request('/users/me/preferences', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, operationContext),
  getSessions: (operationContext, includeMessages = false) => request(`/chat/sessions?include_messages=${includeMessages}`, {}, operationContext),
  getSession: (sessionId, operationContext) => request(`/chat/sessions/${sessionId}`, {}, operationContext),
  sendMessage: (payload, operationContext) =>
    request('/chat/message', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, operationContext),
  getDocuments: (operationContext) => request('/rag/documents', {}, operationContext),
  deleteDocument: (documentId, operationContext) =>
    request(`/rag/documents/${documentId}`, {
      method: 'DELETE',
    }, operationContext),
  uploadDocument: async (file, operationContext) => {
    const formData = new FormData()
    formData.append('file', file)
    return request('/rag/upload', {
      method: 'POST',
      body: formData,
    }, operationContext)
  },
}
