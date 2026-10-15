import { authApi, userApi } from '../services'
import { registerApiSessionReader } from '../services/api'
import { createAuthStore } from './authState'

export const useAuthStore = createAuthStore({
  storage: localStorage,
  getMe: authApi.getMe,
  getPreferences: userApi.getPreferences,
})

registerApiSessionReader(() => useAuthStore.getState().token)
