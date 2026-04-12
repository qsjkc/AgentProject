export type PetType = 'cat' | 'dog' | 'pig'
export type UserStatus = 'active' | 'disabled'

export interface UserPreference {
  id: number
  user_id: number
  pet_type: PetType
  quick_chat_enabled: boolean
  bubble_frequency: number
  created_at: string
  updated_at: string
}

export interface User {
  id: number
  username: string
  email: string
  status: UserStatus
  is_active: boolean
  is_superuser: boolean
  created_at: string
  last_login_at?: string | null
  preferences?: UserPreference | null
}

export interface AdminOverview {
  total_users: number
  active_users: number
  disabled_users: number
  total_documents: number
  admin_users: number
}

export interface AdminUserListItem extends User {
  document_count: number
}

export interface AdminUserCreateInput {
  username: string
  email: string
  password: string
  status: UserStatus
  is_superuser: boolean
}

export interface AdminUserUpdateInput {
  username: string
  email: string
  password?: string
  status: UserStatus
  is_superuser: boolean
}

export interface AdminUserListResponse {
  items: AdminUserListItem[]
  total: number
  page: number
  page_size: number
  search?: string | null
  status?: UserStatus | null
}

export interface DesktopRelease {
  platform: string
  version: string
  filename: string
  download_url: string
  available: boolean
  published_at?: string | null
}
