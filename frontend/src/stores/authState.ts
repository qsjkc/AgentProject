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
  setUser: (user: User | null) => void
  updatePreferences: (preferences: UserPreference) => void
  logout: () => void
}

export function createAuthStore({ storage, getMe, getPreferences }: AuthDependencies) {
  let generation = 0
  let pending: Promise<void> | null = null

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
          set({ token: storedToken, user: null, loading: Boolean(storedToken), error: null })
        }
        return storedToken
      }
      const token = syncStoredToken()
      if (!token) return Promise.resolve()
      if (pending) return pending

      const requestGeneration = generation
      const isCurrent = () => {
        const storedToken = syncStoredToken()
        return generation === requestGeneration && get().token === token && storedToken === token
      }
      set({ loading: true, error: null })
      const request = (async () => {
        try {
          const user = await getMe()
          if (!isCurrent()) return
          const preferences = await getPreferences().catch((error: unknown) => {
            if (getErrorStatus(error) === 401) throw error
            return user.preferences ?? null
          })
          if (!isCurrent()) return
          set({ user: { ...user, preferences }, loading: false, error: null })
        } catch (error) {
          if (!isCurrent()) return
          if (getErrorStatus(error) === 401) {
            get().logout()
          } else {
            set({ loading: false, error: getErrorMessage(error, '暂时无法同步账户信息，请重试。') })
          }
        }
      })()
      pending = request
      void request.finally(() => {
        if (pending === request) pending = null
      })
      return request
    },

    updatePreferences: (preferences) =>
      set((state) => ({ user: state.user ? { ...state.user, preferences } : state.user })),

    logout() {
      generation += 1
      pending = null
      storage.removeItem('token')
      set({ token: null, user: null, loading: false, error: null })
    },
  }))
}
