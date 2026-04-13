import { FormEvent, useEffect, useState } from 'react'

import MetricCard from '../components/MetricCard'
import StatusBadge from '../components/StatusBadge'
import { getErrorMessage } from '../lib/errors'
import { adminApi } from '../services'
import { useAuthStore } from '../stores'
import type {
  AdminOverview,
  AdminUserCreateInput,
  AdminUserListItem,
  AdminUserUpdateInput,
  UserStatus,
} from '../types'

const emptyCreateForm: AdminUserCreateInput = {
  username: '',
  email: '',
  password: '',
  status: 'active',
  is_superuser: false,
}

const emptyEditForm: AdminUserUpdateInput = {
  username: '',
  email: '',
  password: '',
  status: 'active',
  is_superuser: false,
}

const pageSizeOptions = [10, 20, 50]

function roleLabel(isSuperuser: boolean) {
  return isSuperuser ? '管理员' : '普通用户'
}

function formatLastLogin(value?: string | null) {
  if (!value) {
    return '从未登录'
  }
  return new Date(value).toLocaleString('zh-CN')
}

export default function Admin() {
  const { user: currentUser, setUser } = useAuthStore()

  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUserListItem[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<UserStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [createForm, setCreateForm] = useState<AdminUserCreateInput>(emptyCreateForm)
  const [editingUserId, setEditingUserId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<AdminUserUpdateInput>(emptyEditForm)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const loadData = async (
    currentSearch = search,
    currentStatus = status,
    currentPage = page,
    currentPageSize = pageSize,
  ) => {
    setLoading(true)
    setError('')
    try {
      const [overviewData, usersData] = await Promise.all([
        adminApi.getOverview(),
        adminApi.getUsers(currentSearch, currentStatus, currentPage, currentPageSize),
      ])
      setOverview(overviewData)
      setUsers(usersData.items)
      setTotal(usersData.total)
      setPage(usersData.page)
      setPageSize(usersData.page_size)
    } catch (err) {
      setError(getErrorMessage(err, '加载后台数据失败，请稍后重试。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetEditing = () => {
    setEditingUserId(null)
    setEditForm(emptyEditForm)
  }

  const startEditing = (user: AdminUserListItem) => {
    setEditingUserId(user.id)
    setEditForm({
      username: user.username,
      email: user.email,
      password: '',
      status: user.status,
      is_superuser: user.is_superuser,
    })
    setError('')
    setMessage('')
  }

  const handleSearchSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setPage(1)
    await loadData(search, status, 1, pageSize)
  }

  const handlePageSizeChange = async (value: number) => {
    setPage(1)
    setPageSize(value)
    await loadData(search, status, 1, value)
  }

  const handleToggleStatus = async (user: AdminUserListItem) => {
    const nextStatus: UserStatus = user.status === 'active' ? 'disabled' : 'active'
    try {
      setError('')
      setMessage('')
      await adminApi.updateStatus(user.id, nextStatus)
      setMessage(`已将 ${user.username} 设置为${nextStatus === 'active' ? '启用' : '禁用'}。`)
      await loadData(search, status, page, pageSize)
      if (editingUserId === user.id) {
        setEditForm((current) => ({ ...current, status: nextStatus }))
      }
    } catch (err) {
      setError(getErrorMessage(err, '更新用户状态失败。'))
    }
  }

  const handleCreateUser = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      await adminApi.createUser(createForm)
      setCreateForm(emptyCreateForm)
      setMessage('用户已创建。')
      await loadData(search, status, page, pageSize)
    } catch (err) {
      setError(getErrorMessage(err, '创建用户失败，请检查输入信息。'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdateUser = async (event: FormEvent) => {
    event.preventDefault()
    if (!editingUserId) {
      return
    }

    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const payload: AdminUserUpdateInput = {
        ...editForm,
        password: editForm.password?.trim() ? editForm.password : undefined,
      }
      const updatedUser = await adminApi.updateUser(editingUserId, payload)
      if (currentUser?.id === editingUserId) {
        setUser({
          ...currentUser,
          ...updatedUser,
          preferences: currentUser.preferences ?? updatedUser.preferences ?? null,
        })
      }
      setMessage('用户信息已更新。')
      resetEditing()
      await loadData(search, status, page, pageSize)
    } catch (err) {
      setError(getErrorMessage(err, '更新用户失败，请稍后重试。'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteUser = async (user: AdminUserListItem) => {
    const confirmed = window.confirm(
      `确认删除用户 ${user.username} 吗？该操作会同步删除该用户的会话、知识库文档和偏好数据。`,
    )
    if (!confirmed) {
      return
    }

    try {
      setError('')
      setMessage('')
      const response = await adminApi.deleteUser(user.id)
      if (editingUserId === user.id) {
        resetEditing()
      }
      const nextPage = users.length === 1 && page > 1 ? page - 1 : page
      setMessage(response.message)
      await loadData(search, status, nextPage, pageSize)
    } catch (err) {
      setError(getErrorMessage(err, '删除用户失败，请稍后重试。'))
    }
  }

  return (
    <div className="space-y-10 lg:space-y-14">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="eyebrow">Admin Console</div>
          <h1 className="section-title mt-4 text-stone-950">用户管理后台</h1>
          <p className="body-copy mt-4 max-w-3xl text-sm">
            后台不再只是拥挤的表单和表格，而是围绕总览、筛选、编辑与运营四个动作重新组织。所有功能接口保持不变，只提升管理效率和页面质感。
          </p>
        </div>

        <button type="button" onClick={() => void loadData()} className="secondary-button text-sm font-medium">
          刷新数据
        </button>
      </section>

      {overview && (
        <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="总用户数" value={overview.total_users} tone="slate" />
          <MetricCard label="启用用户" value={overview.active_users} tone="emerald" />
          <MetricCard label="禁用用户" value={overview.disabled_users} tone="amber" />
          <MetricCard label="文档总量" value={overview.total_documents} tone="blue" />
          <MetricCard label="管理员" value={overview.admin_users} tone="slate" />
        </section>
      )}

      {(error || message) && (
        <section className="space-y-3">
          {error && <div className="message-banner message-error">{error}</div>}
          {message && <div className="message-banner message-success">{message}</div>}
        </section>
      )}

      <section className="grid gap-8 xl:grid-cols-[0.86fr_1.14fr]">
        <div className="space-y-6">
          <article className="surface-panel reveal-rise rounded-[2.4rem] p-8" style={{ animationDelay: '120ms' }}>
            <div className="eyebrow">Create User</div>
            <h2 className="section-title mt-4 text-stone-950">新增用户</h2>

            <form onSubmit={handleCreateUser} className="mt-8 space-y-5">
              <label className="field-label">
                <span className="field-title">用户名</span>
                <input
                  value={createForm.username}
                  onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))}
                  required
                  minLength={3}
                  className="field-input"
                />
              </label>

              <label className="field-label">
                <span className="field-title">邮箱</span>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                  required
                  className="field-input"
                />
              </label>

              <label className="field-label">
                <span className="field-title">初始密码</span>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                  required
                  minLength={8}
                  className="field-input"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="field-label">
                  <span className="field-title">状态</span>
                  <select
                    value={createForm.status}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, status: event.target.value as UserStatus }))
                    }
                    className="field-select"
                  >
                    <option value="active">启用</option>
                    <option value="disabled">禁用</option>
                  </select>
                </label>

                <label className="subtle-panel flex items-center justify-between gap-6 rounded-[1.7rem] p-5">
                  <span className="text-sm font-medium text-stone-900">管理员权限</span>
                  <input
                    type="checkbox"
                    checked={createForm.is_superuser}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, is_superuser: event.target.checked }))
                    }
                    className="h-5 w-5 rounded border-stone-300"
                  />
                </label>
              </div>

              <button type="submit" disabled={submitting} className="primary-button text-sm font-medium">
                {submitting ? '正在提交...' : '创建用户'}
              </button>
            </form>
          </article>

          <article className="surface-panel reveal-rise rounded-[2.4rem] p-8" style={{ animationDelay: '200ms' }}>
            <div className="eyebrow">Edit User</div>
            <h2 className="section-title mt-4 text-stone-950">
              {editingUserId ? `编辑用户 #${editingUserId}` : '从右侧列表选择一个用户'}
            </h2>

            {editingUserId ? (
              <form onSubmit={handleUpdateUser} className="mt-8 space-y-5">
                <label className="field-label">
                  <span className="field-title">用户名</span>
                  <input
                    value={editForm.username}
                    onChange={(event) => setEditForm((current) => ({ ...current, username: event.target.value }))}
                    required
                    minLength={3}
                    className="field-input"
                  />
                </label>

                <label className="field-label">
                  <span className="field-title">邮箱</span>
                  <input
                    type="email"
                    value={editForm.email}
                    onChange={(event) => setEditForm((current) => ({ ...current, email: event.target.value }))}
                    required
                    className="field-input"
                  />
                </label>

                <label className="field-label">
                  <span className="field-title">新密码</span>
                  <input
                    type="password"
                    value={editForm.password ?? ''}
                    onChange={(event) => setEditForm((current) => ({ ...current, password: event.target.value }))}
                    placeholder="留空表示不修改密码"
                    minLength={8}
                    className="field-input"
                  />
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="field-label">
                    <span className="field-title">状态</span>
                    <select
                      value={editForm.status}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, status: event.target.value as UserStatus }))
                      }
                      className="field-select"
                    >
                      <option value="active">启用</option>
                      <option value="disabled">禁用</option>
                    </select>
                  </label>

                  <label className="subtle-panel flex items-center justify-between gap-6 rounded-[1.7rem] p-5">
                    <span className="text-sm font-medium text-stone-900">管理员权限</span>
                    <input
                      type="checkbox"
                      checked={editForm.is_superuser}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, is_superuser: event.target.checked }))
                      }
                      className="h-5 w-5 rounded border-stone-300"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button type="submit" disabled={submitting} className="primary-button text-sm font-medium">
                    {submitting ? '正在保存...' : '保存修改'}
                  </button>
                  <button type="button" onClick={resetEditing} className="secondary-button text-sm font-medium">
                    取消编辑
                  </button>
                </div>
              </form>
            ) : (
              <p className="body-copy mt-6 text-sm">
                点击右侧列表中的“编辑”后，这里会载入该用户的基础资料。你可以修改用户名、邮箱、角色、状态，并按需重设密码。
              </p>
            )}
          </article>
        </div>

        <div className="space-y-6">
          <article className="surface-panel reveal-rise rounded-[2.4rem] p-8" style={{ animationDelay: '140ms' }}>
            <form onSubmit={handleSearchSubmit} className="grid gap-4 xl:grid-cols-[1fr_auto_auto_auto]">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索用户名或邮箱"
                className="field-input"
              />
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as UserStatus | 'all')}
                className="field-select"
              >
                <option value="all">全部状态</option>
                <option value="active">启用</option>
                <option value="disabled">禁用</option>
              </select>
              <select
                value={pageSize}
                onChange={(event) => void handlePageSizeChange(Number(event.target.value))}
                className="field-select"
              >
                {pageSizeOptions.map((value) => (
                  <option key={value} value={value}>
                    每页 {value} 条
                  </option>
                ))}
              </select>
              <button type="submit" className="primary-button text-sm font-medium">
                查询
              </button>
            </form>

            <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="text-sm text-stone-600">
                共 {total} 位用户，当前第 {page} / {totalPages} 页
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => void loadData(search, status, page - 1, pageSize)}
                  className="secondary-button text-sm font-medium"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages || loading}
                  onClick={() => void loadData(search, status, page + 1, pageSize)}
                  className="secondary-button text-sm font-medium"
                >
                  下一页
                </button>
              </div>
            </div>
          </article>

          <article className="surface-panel reveal-rise rounded-[2.4rem] p-6 md:p-8" style={{ animationDelay: '220ms' }}>
            <div className="overflow-x-auto">
              <table className="premium-table min-w-[920px]">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>文档数</th>
                    <th>最近登录</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-sm text-stone-500">
                        正在加载用户列表...
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-sm text-stone-500">
                        没有匹配的用户。
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => {
                      const isCurrentUser = currentUser?.id === user.id

                      return (
                        <tr key={user.id}>
                          <td>
                            <div className="font-medium text-stone-950">{user.username}</div>
                            <div className="mt-2 text-xs text-stone-500">{user.email}</div>
                          </td>
                          <td>
                            <span className="inline-flex rounded-full border border-stone-200 bg-white/70 px-3 py-1 text-xs font-medium text-stone-700">
                              {roleLabel(user.is_superuser)}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={user.status} />
                          </td>
                          <td>{user.document_count}</td>
                          <td>{formatLastLogin(user.last_login_at)}</td>
                          <td>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => startEditing(user)}
                                className="secondary-button min-h-0 px-4 py-2 text-xs font-medium"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleStatus(user)}
                                disabled={isCurrentUser}
                                className="secondary-button min-h-0 px-4 py-2 text-xs font-medium"
                              >
                                {user.status === 'active' ? '禁用' : '启用'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteUser(user)}
                                disabled={isCurrentUser}
                                className="inline-flex min-h-0 items-center justify-center rounded-full border border-rose-200 px-4 py-2 text-xs font-medium text-rose-700 transition hover:border-rose-400 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
