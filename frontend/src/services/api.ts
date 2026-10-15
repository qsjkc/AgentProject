import axios from 'axios'
import { AUTH_EXPIRED_EVENT, shouldExpireSession } from '../lib/auth'
import { installApiSessionBinding } from '../lib/apiSession'

const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api/v1'

const api = axios.create({
  baseURL: defaultBaseUrl,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
  },
})

export const registerApiSessionReader = installApiSessionBinding(api, () => localStorage.getItem('token'))

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (shouldExpireSession(
      error.response?.status,
      error.config?.url,
      error.config?.headers?.Authorization,
      localStorage.getItem('token'),
    )) {
      localStorage.removeItem('token')
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    }
    return Promise.reject(error)
  }
)

export const apiBaseUrl = defaultBaseUrl
export const apiOrigin = defaultBaseUrl.startsWith('http')
  ? new URL(defaultBaseUrl).origin
  : window.location.origin

export default api
