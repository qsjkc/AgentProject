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
  return new Date(value).toLocaleString()
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
      setError(getErrorMessage(err, '加载后台数据失败。'))
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
      setError(getErrorMessage(err, '创建用户失败。'))
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
      setError(getErrorMessage(err, '更新用户失败。'))
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
      setError(getErrorMessage(err, '删除用户失败。'))
    }
  }

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Admin Console</div>
          <h1 className="mt-4 text-4xl font-semibold text-slate-950">用户管理后台</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
            管理员可以在这里查看用户状态、创建账户、修改角色、重置密码入口信息，并删除不再需要的账户。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadData()}
          className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
        >
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
          {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
          {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}
        </section>
      )}

      <section className="grid gap-8 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Create User</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">新增用户</h2>

          <form onSubmit={handleCreateUser} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">用户名</span>
              <input
                value={createForm.username}
                onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))}
                required
                minLength={3}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">邮箱</span>
              <input
                type="email"
                value={createForm.email}
                onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">初始密码</span>
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                required
                minLength={8}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">状态</span>
                <select
                  value={createForm.status}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, status: event.target.value as UserStatus }))
                  }
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                >
                  <option value="active">启用</option>
                  <option value="disabled">禁用</option>
                </select>
              </label>

              <label className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span className="text-sm text-slate-700">管理员权限</span>
                <input
                  type="checkbox"
                  checked={createForm.is_superuser}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, is_superuser: event.target.checked }))
                  }
                  className="h-5 w-5 rounded border-slate-300"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? '提交中...' : '创建用户'}
            </button>
          </form>
        </article>

        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Edit User</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">
            {editingUserId ? `编辑用户 #${editingUserId}` : '从下方列表选择一个用户进行编辑'}
          </h2>

          {editingUserId ? (
            <form onSubmit={handleUpdateUser} className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">用户名</span>
                <input
                  value={editForm.username}
                  onChange={(event) => setEditForm((current) => ({ ...current, username: event.target.value }))}
                  required
                  minLength={3}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">邮箱</span>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(event) => setEditForm((current) => ({ ...current, email: event.target.value }))}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">新密码</span>
                <input
                  type="password"
                  value={editForm.password ?? ''}
                  onChange={(event) => setEditForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder="留空表示不修改密码"
                  minLength={8}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-sm text-slate-600">状态</span>
                  <select
                    value={editForm.status}
                    onChange={(event) =>
                      setEditForm((current) => ({ ...current, status: event.target.value as UserStatus }))
                    }
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                  >
                    <option value="active">启用</option>
                    <option value="disabled">禁用</option>
                  </select>
                </label>

                <label className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <span className="text-sm text-slate-700">管理员权限</span>
                  <input
                    type="checkbox"
                    checked={editForm.is_superuser}
                    onChange={(event) =>
                      setEditForm((current) => ({ ...current, is_superuser: event.target.checked }))
                    }
                    className="h-5 w-5 rounded border-slate-300"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? '保存中...' : '保存修改'}
                </button>
                <button
                  type="button"
                  onClick={resetEditing}
                  className="rounded-2xl border border-slate-300 px-6 py-3 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  取消编辑
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-6 text-sm leading-7 text-slate-600">
              在下方列表中点击“编辑”后，这里会加载用户资料。你可以修改用户名、邮箱、角色、启用状态，以及按需重设密码。
            </p>
          )}
        </article>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <form onSubmit={handleSearchSubmit} className="mb-6 flex flex-wrap gap-4">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索用户名或邮箱"
            className="min-w-[260px] flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as UserStatus | 'all')}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          >
            <option value="all">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
          <select
            value={pageSize}
            onChange={(event) => void handlePageSizeChange(Number(event.target.value))}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                每页 {value} 条
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            查询
          </button>
        </form>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
          <div>
            共 {total} 位用户，当前第 {page} / {totalPages} 页
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => void loadData(search, status, page - 1, pageSize)}
              className="rounded-full border border-slate-300 px-4 py-2 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => void loadData(search, status, page + 1, pageSize)}
              className="rounded-full border border-slate-300 px-4 py-2 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-y-3">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.2em] text-slate-500">
                <th className="px-4">用户</th>
                <th className="px-4">角色</th>
                <th className="px-4">状态</th>
                <th className="px-4">文档数</th>
                <th className="px-4">最后登录</th>
                <th className="px-4">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-slate-500">
                    正在加载数据...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-slate-500">
                    没有匹配的用户。
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const isCurrentUser = currentUser?.id === user.id

                  return (
                    <tr key={user.id} className="bg-slate-50 text-sm text-slate-700">
                      <td className="rounded-l-[1.5rem] px-4 py-4">
                        <div className="font-medium text-slate-950">{user.username}</div>
                        <div className="mt-1 text-xs text-slate-500">{user.email}</div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700">
                          {roleLabel(user.is_superuser)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <StatusBadge status={user.status} />
                      </td>
                      <td className="px-4 py-4">{user.document_count}</td>
                      <td className="px-4 py-4">{formatLastLogin(user.last_login_at)}</td>
                      <td className="rounded-r-[1.5rem] px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => startEditing(user)}
                            className="rounded-full border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleStatus(user)}
                            disabled={isCurrentUser}
                            className="rounded-full border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {user.status === 'active' ? '禁用' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteUser(user)}
                            disabled={isCurrentUser}
                            className="rounded-full border border-rose-200 px-4 py-2 text-xs font-medium text-rose-700 transition hover:border-rose-500 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
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
      </section>
    </div>
  )
}
