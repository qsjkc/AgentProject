import { normalizeApiBaseUrl } from './api-base-url'

const LOCAL_API_BASE_URL = 'http://127.0.0.1:5000/api/v1'

const buildTimeApiBaseUrl = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL || __DETACHYM_DEFAULT_API_BASE_URL__ || '',
)
let cachedApiBaseUrl = import.meta.env.DEV ? LOCAL_API_BASE_URL : buildTimeApiBaseUrl

function getDesktopBridge() {
  return window.desktopBridge || null
}

function getUnconfiguredServerMessage() {
  return import.meta.env.DEV
    ? '未检测到桌面端服务，请先启动本地后端或配置服务地址。'
    : '请先配置服务地址，再使用桌面客户端。'
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

export async function setApiBaseUrl(value) {
  const normalizedValue = normalizeApiBaseUrl(value)
  const bridge = getDesktopBridge()
  await bridge?.setApiBaseUrl?.(normalizedValue)
  cachedApiBaseUrl = normalizedValue
  return normalizedValue
}

export async function getLanguage() {
  return getDesktopBridge()?.getLanguage?.()
}

export async function setLanguage(value) {
  return getDesktopBridge()?.setLanguage?.(value)
}

export async function checkApiConnection(value) {
  const apiBaseUrl = normalizeApiBaseUrl(value)
  if (!apiBaseUrl) {
    throw new Error(getUnconfiguredServerMessage())
  }

  const response = await fetch(`${apiBaseUrl}/public/version/win-x64`)
  if (!response.ok) {
    throw new Error('无法连接到 Detachym 服务。')
  }

  return apiBaseUrl
}

export async function getSessionToken() {
  return getDesktopBridge()?.getSessionToken?.()
}

export async function setSessionToken(token) {
  return getDesktopBridge()?.setSessionToken?.(token)
}

export async function clearSessionToken() {
  return getDesktopBridge()?.clearSessionToken?.()
}

async function request(path, options = {}) {
  const apiBaseUrl = await requireApiBaseUrl()
  const token = await getSessionToken()
  const headers = new Headers(options.headers || {})

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: '请求失败' }))
    throw new Error(payload.detail || '请求失败')
  }

  return response.json()
}

export async function login(username, password) {
  const apiBaseUrl = await requireApiBaseUrl()
  const formData = new FormData()
  formData.append('username', username)
  formData.append('password', password)

  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    body: formData,
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: '登录失败' }))
    throw new Error(payload.detail || '登录失败')
  }

  const data = await response.json()
  await setSessionToken(data.access_token)
  return data
}

export const desktopApi = {
  me: () => request('/auth/me'),
  getPreferences: () => request('/users/me/preferences'),
  updatePreferences: (payload) =>
    request('/users/me/preferences', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getSessions: () => request('/chat/sessions'),
  getSession: (sessionId) => request(`/chat/sessions/${sessionId}`),
  sendMessage: (payload) =>
    request('/chat/message', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getDocuments: () => request('/rag/documents'),
  deleteDocument: (documentId) =>
    request(`/rag/documents/${documentId}`, {
      method: 'DELETE',
    }),
  uploadDocument: async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return request('/rag/upload', {
      method: 'POST',
      body: formData,
    })
  },
}
