import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'

import AdminWeeklyReviewFunnel from '../components/AdminWeeklyReviewFunnel'
import MetricCard from '../components/MetricCard'
import StatusBadge from '../components/StatusBadge'
import { getErrorMessage } from '../lib/errors'
import { createAdminOperations } from '../lib/adminOperations'
import { matchingUiSession } from '../lib/apiSession'
import { formatApiDateTime } from '../lib/apiTime'
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

interface UserQuery {
  search: string
  status: UserStatus | 'all'
  page: number
  pageSize: number
}

interface PendingMutation {
  kind: 'create' | 'update' | 'status' | 'delete'
  userId?: number
}

function roleLabel(isSuperuser: boolean) {
  return isSuperuser ? '管理员' : '普通用户'
}

function formatLastLogin(value?: string | null) {
  if (!value) {
    return '从未登录'
  }
  return formatApiDateTime(value)
}

export default function Admin() {
  const { token, user: currentUser, setUser } = useAuthStore()

  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUserListItem[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<UserStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null)
  const [listError, setListError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [createForm, setCreateForm] = useState<AdminUserCreateInput>(emptyCreateForm)
  const [editingUserId, setEditingUserId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<AdminUserUpdateInput>(emptyEditForm)
  const appliedQuery = useRef<UserQuery>({ search: '', status: 'all', page: 1, pageSize: 20 })
  const createRevision = useRef(0)
  const editRevision = useRef(0)
  const editingUser = useRef<number | null>(null)
  const visibleSession = useRef({ token, userId: currentUser?.id ?? null })
  visibleSession.current = { token, userId: currentUser?.id ?? null }
  const [operations] = useState(() => createAdminOperations(() => {
    const state = useAuthStore.getState()
    return matchingUiSession(visibleSession.current, {
      token: state.token, userId: state.user?.id ?? null,
    }, localStorage.getItem('token'))
  }))

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const loadData = useCallback(async (query = appliedQuery.current): Promise<void> => {
    const request = operations.beginRead()
    if (!request.isCurrent()) return
    appliedQuery.current = query
    setLoading(true)
    setListError('')
    try {
      const [overviewData, usersData] = await Promise.all([
        adminApi.getOverview(),
        adminApi.getUsers(query.search, query.status, query.page, query.pageSize),
      ])
      if (!request.isCurrent()) return
      const lastPage = Math.max(1, Math.ceil(usersData.total / usersData.page_size))
      if (usersData.page > lastPage) {
        await loadData({ ...query, page: lastPage })
        return
      }
      setOverview(overviewData)
      setUsers(usersData.items)
      setTotal(usersData.total)
      setPage(usersData.page)
      setPageSize(usersData.page_size)
    } catch (err) {
      if (request.isCurrent()) setListError(getErrorMessage(err, '加载后台数据失败。'))
    } finally {
      if (request.isCurrent()) setLoading(false)
    }
  }, [operations])

  useEffect(() => {
    operations.mount()
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      if (next.token !== previous.token || next.user?.id !== previous.user?.id) {
        operations.invalidate()
      }
    })
    void loadData()
    return () => {
      unsubscribe()
      operations.unmount()
    }
  }, [loadData, operations])

  const resetEditing = () => {
    editRevision.current += 1
    editingUser.current = null
    setEditingUserId(null)
    setEditForm(emptyEditForm)
  }

  const startEditing = (user: AdminUserListItem) => {
    editRevision.current += 1
    editingUser.current = user.id
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

  const updateCreateForm = (patch: Partial<AdminUserCreateInput>) => {
    createRevision.current += 1
    setCreateForm((current) => ({ ...current, ...patch }))
  }

  const updateEditForm = (patch: Partial<AdminUserUpdateInput>) => {
    editRevision.current += 1
    setEditForm((current) => ({ ...current, ...patch }))
  }

  const handleSearchSubmit = async (event: FormEvent) => {
    event.preventDefault()
    await loadData({ search: search.trim(), status, page: 1, pageSize })
  }

  const handlePageSizeChange = async (value: number) => {
    setPageSize(value)
    await loadData({ ...appliedQuery.current, page: 1, pageSize: value })
  }

  const handleToggleStatus = async (user: AdminUserListItem) => {
    const operation = operations.beginMutation()
    if (!operation) return
    const draftRevision = editRevision.current
    setPendingMutation({ kind: 'status', userId: user.id })
    const nextStatus: UserStatus = user.status === 'active' ? 'disabled' : 'active'
    try {
      setError('')
      setMessage('')
      await adminApi.updateStatus(user.id, nextStatus)
      if (!operation.isCurrent()) return
      setMessage(`已将 ${user.username} 设置为${nextStatus === 'active' ? '启用' : '禁用'}。`)
      if (editingUser.current === user.id && editRevision.current === draftRevision) {
        setEditForm((current) => ({ ...current, status: nextStatus }))
      }
      await loadData()
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '更新用户状态失败。'))
    } finally {
      if (operation.isCurrent()) setPendingMutation(null)
      operation.finish()
    }
  }

  const handleCreateUser = async (event: FormEvent) => {
    event.preventDefault()
    const operation = operations.beginMutation()
    if (!operation) return
    const draftRevision = createRevision.current
    const payload = { ...createForm }
    setPendingMutation({ kind: 'create' })
    setError('')
    setMessage('')
    try {
      await adminApi.createUser(payload)
      if (!operation.isCurrent()) return
      const draftUnchanged = createRevision.current === draftRevision
      if (draftUnchanged) {
        createRevision.current += 1
        setCreateForm(emptyCreateForm)
      }
      setMessage(`用户 ${payload.username} 已创建。${draftUnchanged ? '' : '当前表单中的新内容尚未提交。'}`)
      await loadData()
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '创建用户失败。'))
    } finally {
      if (operation.isCurrent()) setPendingMutation(null)
      operation.finish()
    }
  }

  const handleUpdateUser = async (event: FormEvent) => {
    event.preventDefault()
    const userId = editingUser.current
    if (!userId) return
    const operation = operations.beginMutation()
    if (!operation) return
    const draftRevision = editRevision.current
    setPendingMutation({ kind: 'update', userId })
    setError('')
    setMessage('')
    try {
      const payload: AdminUserUpdateInput = {
        ...editForm,
        password: editForm.password?.trim() ? editForm.password : undefined,
      }
      const updatedUser = await adminApi.updateUser(userId, payload)
      if (!operation.isCurrent()) return
      const latestCurrentUser = useAuthStore.getState().user
      if (latestCurrentUser?.id === userId) {
        setUser({
          ...latestCurrentUser,
          ...updatedUser,
          preferences: latestCurrentUser.preferences ?? updatedUser.preferences ?? null,
        })
      }
      const sameEditor = editingUser.current === userId
      const draftUnchanged = editRevision.current === draftRevision
      setMessage(`用户 ${updatedUser.username} 的信息已更新。${sameEditor && !draftUnchanged ? '后续编辑的内容尚未保存。' : ''}`)
      if (sameEditor && draftUnchanged) resetEditing()
      await loadData()
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '更新用户失败。'))
    } finally {
      if (operation.isCurrent()) setPendingMutation(null)
      operation.finish()
    }
  }

  const handleDeleteUser = async (user: AdminUserListItem) => {
    const operation = operations.beginMutation()
    if (!operation) return
    const confirmed = window.confirm(
      `确认删除用户 ${user.username} 吗？该操作会同步删除该用户的会话、知识库文档和偏好数据。`,
    )
    if (!confirmed || !operation.isCurrent()) {
      operation.finish()
      return
    }

    setPendingMutation({ kind: 'delete', userId: user.id })
    try {
      setError('')
      setMessage('')
      const response = await adminApi.deleteUser(user.id)
      if (!operation.isCurrent()) return
      if (editingUser.current === user.id) {
        resetEditing()
      }
      setMessage(response.message)
      await loadData()
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '删除用户失败。'))
    } finally {
      if (operation.isCurrent()) setPendingMutation(null)
      operation.finish()
    }
  }

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Admin Console</div>
          <h1 className="mt-4 text-4xl font-semibold text-slate-950">用户管理后台</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
            管理员可以在这里查看用户状态、创建账户、修改角色、重置密码入口信息，并删除不再需要的账号。
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

      {(error || message || listError) && (
        <section className="space-y-3">
          {error && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
          {listError && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{listError}</div>}
          {message && <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}
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
                onChange={(event) => updateCreateForm({ username: event.target.value })}
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
                onChange={(event) => updateCreateForm({ email: event.target.value })}
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">初始密码</span>
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => updateCreateForm({ password: event.target.value })}
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
                    updateCreateForm({ status: event.target.value as UserStatus })
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
                    updateCreateForm({ is_superuser: event.target.checked })
                  }
                  className="h-5 w-5 rounded border-slate-300"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={Boolean(pendingMutation)}
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pendingMutation?.kind === 'create' ? '提交中...' : '创建用户'}
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
                  onChange={(event) => updateEditForm({ username: event.target.value })}
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
                  onChange={(event) => updateEditForm({ email: event.target.value })}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">新密码</span>
                <input
                  type="password"
                  value={editForm.password ?? ''}
                  onChange={(event) => updateEditForm({ password: event.target.value })}
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
                      updateEditForm({ status: event.target.value as UserStatus })
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
                      updateEditForm({ is_superuser: event.target.checked })
                    }
                    className="h-5 w-5 rounded border-slate-300"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={Boolean(pendingMutation)}
                  className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pendingMutation?.kind === 'update' && pendingMutation.userId === editingUserId ? '保存中...' : '保存修改'}
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
            aria-label="搜索用户名或邮箱"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索用户名或邮箱"
            className="min-w-0 basis-64 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          />
          <select
            aria-label="筛选用户状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as UserStatus | 'all')}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          >
            <option value="all">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
          <select
            aria-label="每页用户数"
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
              onClick={() => void loadData({ ...appliedQuery.current, page: page - 1 })}
              className="rounded-full border border-slate-300 px-4 py-2 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => void loadData({ ...appliedQuery.current, page: page + 1 })}
              className="rounded-full border border-slate-300 px-4 py-2 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>

        <div className="overflow-x-auto" aria-busy={loading}>
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
              ) : listError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-slate-600">
                    未能加载当前查询。
                    <button type="button" onClick={() => void loadData()} className="ml-3 rounded-full border border-slate-300 px-4 py-2">重新加载</button>
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
                            disabled={isCurrentUser || Boolean(pendingMutation)}
                            className="rounded-full border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {pendingMutation?.kind === 'status' && pendingMutation.userId === user.id ? '更新中...' : user.status === 'active' ? '禁用' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteUser(user)}
                            disabled={isCurrentUser || Boolean(pendingMutation)}
                            className="rounded-full border border-rose-200 px-4 py-2 text-xs font-medium text-rose-700 transition hover:border-rose-500 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {pendingMutation?.kind === 'delete' && pendingMutation.userId === user.id ? '删除中...' : '删除'}
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

      <AdminWeeklyReviewFunnel />
    </div>
  )
}
