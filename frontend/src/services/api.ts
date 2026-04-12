import axios from 'axios'

const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api/v1'

const api = axios.create({
  baseURL: defaultBaseUrl,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export const apiBaseUrl = defaultBaseUrl
export const apiOrigin = defaultBaseUrl.startsWith('http')
  ? new URL(defaultBaseUrl).origin
  : window.location.origin

export default api
