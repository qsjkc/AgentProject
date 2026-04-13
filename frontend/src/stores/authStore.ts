import { create } from 'zustand'

import { authApi, userApi } from '../services'
import type { User, UserPreference } from '../types'

interface AuthState {
  token: string | null
  user: User | null
  loading: boolean
  setToken: (token: string | null) => void
  fetchUser: () => Promise<void>
  setUser: (user: User | null) => void
  updatePreferences: (preferences: UserPreference) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: null,
  loading: Boolean(localStorage.getItem('token')),

  setToken: (token) => {
    if (token) {
      localStorage.setItem('token', token)
    } else {
      localStorage.removeItem('token')
    }
    set((state) => ({
      token,
      loading: token ? !state.user : false,
    }))
  },

  setUser: (user) => set({ user, loading: false }),

  async fetchUser() {
    const { token } = get()
    if (!token) {
      set({ user: null, loading: false })
      return
    }

    set({ loading: true })
    try {
      const user = await authApi.getMe()
      const preferences = await userApi.getPreferences().catch(() => user.preferences ?? null)
      set({
        user: {
          ...user,
          preferences: preferences ?? user.preferences ?? null,
        },
        loading: false,
      })
    } catch {
      localStorage.removeItem('token')
      set({ token: null, user: null, loading: false })
    }
  },

  updatePreferences: (preferences) =>
    set((state) => ({
      user: state.user
        ? {
            ...state.user,
            preferences,
          }
        : state.user,
    })),

  logout: () => {
    localStorage.removeItem('token')
    set({ token: null, user: null, loading: false })
  },
}))
