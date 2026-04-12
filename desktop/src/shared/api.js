const LOCAL_API_BASE_URL = 'http://127.0.0.1:5000/api/v1'

const buildTimeApiBaseUrl = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL || __DETACHYM_DEFAULT_API_BASE_URL__ || ''
)
let cachedApiBaseUrl = import.meta.env.DEV ? LOCAL_API_BASE_URL : buildTimeApiBaseUrl

function normalizeApiBaseUrl(value) {
  const rawValue = String(value || '').trim()
  if (!rawValue) {
    return ''
  }

  let normalizedValue = rawValue.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(normalizedValue)) {
    normalizedValue = `http://${normalizedValue}`
  }

  if (!/\/api\/v\d+$/i.test(normalizedValue)) {
    if (/\/api$/i.test(normalizedValue)) {
      normalizedValue = `${normalizedValue}/v1`
    } else {
      normalizedValue = `${normalizedValue}/api/v1`
    }
  }

  return normalizedValue
}

function getDesktopBridge() {
  return window.desktopBridge || null
}

function getUnconfiguredServerMessage() {
  return import.meta.env.DEV
    ? 'Desktop API is not configured. Start the local backend or set a server URL.'
    : 'Please configure the server URL before using the desktop client.'
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

export async function checkApiConnection(value) {
  const apiBaseUrl = normalizeApiBaseUrl(value)
  if (!apiBaseUrl) {
    throw new Error(getUnconfiguredServerMessage())
  }

  const response = await fetch(`${apiBaseUrl}/public/version/win-x64`)
  if (!response.ok) {
    throw new Error('Unable to reach the Detachym service.')
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
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(payload.detail || 'Request failed')
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
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'Login failed' }))
    throw new Error(payload.detail || 'Login failed')
  }

  const data = await response.json()
  await setSessionToken(data.access_token)
  return data
}

export const desktopApi = {
  me: () => request('/auth/me'),
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
