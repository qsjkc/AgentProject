import api, { apiOrigin } from './api'
import { resolveDownloadUrlWithOrigin } from './url'
import type {
  AdminOverview,
  AdminUserCreateInput,
  AdminUserListItem,
  AdminUserListResponse,
  AdminUserUpdateInput,
  DesktopRelease,
  PetType,
  User,
  UserPreference,
  UserStatus,
} from '../types'

export interface RegisterRequest {
  username: string
  email: string
  password: string
  verification_code: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface ChangePasswordRequest {
  current_password: string
  new_password: string
}

export interface PreferenceUpdateRequest {
  pet_type: PetType
  quick_chat_enabled: boolean
  bubble_frequency: number
}

export const authApi = {
  async login(data: LoginRequest): Promise<{ access_token: string; token_type: string }> {
    const formData = new FormData()
    formData.append('username', data.username)
    formData.append('password', data.password)
    const response = await api.post('/auth/login', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  async register(data: RegisterRequest): Promise<User> {
    const response = await api.post('/auth/register', data)
    return response.data
  },

  async getMe(): Promise<User> {
    const response = await api.get('/auth/me')
    return response.data
  },

  async sendVerificationCode(email: string) {
    const response = await api.post('/auth/send-verification-code', { email })
    return response.data as { message: string }
  },

  async forgotPassword(email: string) {
    const response = await api.post('/auth/forgot-password', { email })
    return response.data as { message: string }
  },

  async resetPassword(email: string, verification_code: string, new_password: string) {
    const response = await api.post('/auth/reset-password', {
      email,
      verification_code,
      new_password,
    })
    return response.data as { message: string }
  },

  async changePassword(payload: ChangePasswordRequest) {
    const response = await api.post('/auth/change-password', payload)
    return response.data as { message: string }
  },
}

export const userApi = {
  async getPreferences(): Promise<UserPreference> {
    const response = await api.get('/users/me/preferences')
    return response.data
  },

  async updatePreferences(payload: PreferenceUpdateRequest): Promise<UserPreference> {
    const response = await api.put('/users/me/preferences', payload)
    return response.data
  },
}

export const adminApi = {
  async getOverview(): Promise<AdminOverview> {
    const response = await api.get('/admin/overview')
    return response.data
  },

  async getUsers(
    search?: string,
    status?: UserStatus | 'all',
    page = 1,
    pageSize = 20,
  ): Promise<AdminUserListResponse> {
    const params: Record<string, string> = {}
    if (search) {
      params.search = search
    }
    if (status && status !== 'all') {
      params.status = status
    }
    params.page = String(page)
    params.page_size = String(pageSize)
    const response = await api.get('/admin/users', { params })
    return response.data
  },

  async updateStatus(userId: number, status: UserStatus) {
    const response = await api.patch(`/admin/users/${userId}/status`, { status })
    return response.data
  },

  async createUser(payload: AdminUserCreateInput): Promise<AdminUserListItem> {
    const response = await api.post('/admin/users', payload)
    return response.data
  },

  async updateUser(userId: number, payload: AdminUserUpdateInput): Promise<AdminUserListItem> {
    const response = await api.put(`/admin/users/${userId}`, payload)
    return response.data
  },

  async deleteUser(userId: number) {
    const response = await api.delete(`/admin/users/${userId}`)
    return response.data as { message: string }
  },
}

export const publicApi = {
  async getWindowsRelease(): Promise<DesktopRelease> {
    const response = await api.get('/public/version/win-x64')
    return response.data
  },
}

export const resolveDownloadUrl = (release: DesktopRelease) => {
  return resolveDownloadUrlWithOrigin(apiOrigin, release)
}
