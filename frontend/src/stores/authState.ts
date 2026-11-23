import { create } from 'zustand'

import { getErrorMessage, getErrorStatus } from '../lib/errors.js'
import type { User, UserPreference } from '../types/index.js'

interface AuthDependencies {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  getMe: () => Promise<User>
  getPreferences: () => Promise<UserPreference>
}

interface AuthState {
  token: string | null
  user: User | null
  loading: boolean
  error: string | null
  setToken: (token: string | null) => void
  fetchUser: () => Promise<void>
  resumeUserSync: () => void
  setUser: (user: User | null) => void
  updatePreferences: (preferences: UserPreference) => void
  logout: () => void
}

function readProfilePreferences(user: User): UserPreference | null {
  const preferences = user.preferences
  if (!preferences || !Number.isSafeInteger(user.id) || preferences.user_id !== user.id) return null

  const { id, pet_type, quick_chat_enabled, bubble_frequency, created_at, updated_at } = preferences
  if (pet_type !== 'cat' && pet_type !== 'dog' && pet_type !== 'pig') return null
  if (!Number.isSafeInteger(id) || typeof quick_chat_enabled !== 'boolean') return null
  if (!Number.isInteger(bubble_frequency) || bubble_frequency < 30 || bubble_frequency > 3600) return null
  if (typeof created_at !== 'string' || !Number.isFinite(Date.parse(created_at))) return null
  if (typeof updated_at !== 'string' || !Number.isFinite(Date.parse(updated_at))) return null

  return preferences
}

export function createAuthStore({ storage, getMe, getPreferences }: AuthDependencies) {
  let generation = 0
  let pending: { request: Promise<void>; retryAfterReconnect: boolean } | null = null
  let canRetryOnReconnect = false

  return create<AuthState>((set, get) => ({
    token: storage.getItem('token'),
    user: null,
    loading: Boolean(storage.getItem('token')),
    error: null,

    setToken(token) {
      if (token) storage.setItem('token', token)
      else storage.removeItem('token')
      if (get().token === token) return
      generation += 1
      pending = null
      canRetryOnReconnect = false
      set({ token, user: null, loading: Boolean(token), error: null })
    },

    setUser: (user) => set({ user, loading: false, error: null }),

    fetchUser() {
      // Storage events arrive asynchronously. Another tab may already have
      // replaced or removed this session before its event reaches this tab.
      const syncStoredToken = () => {
        const storedToken = storage.getItem('token')
        if (get().token !== storedToken) {
          generation += 1
          pending = null
          canRetryOnReconnect = false
          set({ token: storedToken, user: null, loading: Boolean(storedToken), error: null })
        }
        return storedToken
      }
      const token = syncStoredToken()
      if (!token) return Promise.resolve()
      if (pending) return pending.request

      const requestGeneration = generation
      const isCurrent = () => {
        const storedToken = syncStoredToken()
        return generation === requestGeneration && get().token === token && storedToken === token
      }
      canRetryOnReconnect = false
      set({ loading: true, error: null })
      const request = (async () => {
        try {
          const user = await getMe()
          if (!isCurrent()) return
          const preferences = readProfilePreferences(user) ?? await getPreferences().catch((error: unknown) => {
            if (getErrorStatus(error) === 401) throw error
            return null
          })
          if (!isCurrent()) return
          set({ user: { ...user, preferences }, loading: false, error: null })
        } catch (error) {
          if (!isCurrent()) return
          const status = getErrorStatus(error)
          if (status === 401) {
            get().logout()
          } else {
            canRetryOnReconnect = status === undefined || status === 408 || status >= 500
            set({ loading: false, error: getErrorMessage(error, '暂时无法同步账户信息，请重试。') })
          }
        }
      })()
      const active = { request, retryAfterReconnect: false }
      pending = active
      void request.finally(() => {
        if (pending !== active) return
        pending = null
        if (active.retryAfterReconnect) get().resumeUserSync()
      })
      return request
    },

    resumeUserSync() {
      const { token, user, error } = get()
      if (!token || user || token !== storage.getItem('token')) return
      // The failed request may settle after the browser has already come online.
      if (pending) pending.retryAfterReconnect = true
      else if (error && canRetryOnReconnect) void get().fetchUser()
    },

    updatePreferences: (preferences) =>
      set((state) => ({ user: state.user ? { ...state.user, preferences } : state.user })),

    logout() {
      generation += 1
      pending = null
      canRetryOnReconnect = false
      storage.removeItem('token')
      set({ token: null, user: null, loading: false, error: null })
    },
  }))
}
