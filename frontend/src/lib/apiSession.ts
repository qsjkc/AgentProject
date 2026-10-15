import type { AxiosInstance } from 'axios'

export interface UiSession {
  token: string | null
  userId: number | null
}

export function matchingUiSession(visible: UiSession, current: UiSession, storedToken: string | null): UiSession {
  if (!visible.token || visible.userId === null
    || visible.token !== current.token || visible.userId !== current.userId
    || visible.token !== storedToken) {
    return { token: null, userId: null }
  }
  return current
}

function isPublicRequest(url: string | undefined): boolean {
  return /^\/auth\/(login|register|send-verification-code|forgot-password|reset-password)\/?(?:[?#]|$)/.test(url ?? '')
    || /^\/public(?:\/|[?#]|$)/.test(url ?? '')
}

export function installApiSessionBinding(api: AxiosInstance, readStoredToken: () => string | null) {
  let readSessionToken: () => string | null = () => null

  // Keep this interceptor synchronous: an async chain would choose the account
  // in a later microtask, after the caller's visible session may have changed.
  api.interceptors.request.use((config) => {
    if (isPublicRequest(config.url)) {
      config.headers.delete('Authorization')
      return config
    }
    const token = readSessionToken()
    if (!token || token !== readStoredToken()) {
      throw new Error('登录状态已改变，请等待账户同步后重试。')
    }
    config.headers.set('Authorization', `Bearer ${token}`)
    return config
  }, (error: unknown) => {
    // Axios' synchronous branch otherwise continues to dispatch the request.
    throw error
  }, { synchronous: true })

  // The store registers after initialization; this module must not import it.
  return (reader: () => string | null) => {
    readSessionToken = reader
  }
}
