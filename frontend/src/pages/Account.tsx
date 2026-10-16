import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { getErrorMessage } from '../lib/errors'
import { createAdminOperations } from '../lib/adminOperations'
import { matchingUiSession } from '../lib/apiSession'
import { formatApiDate, formatApiDateTime } from '../lib/apiTime'
import { useDesktopRelease } from '../hooks/useDesktopRelease'
import { authApi, resolveDownloadUrl, userApi } from '../services'
import { useAuthStore } from '../stores'
import type { PetType } from '../types'

const petOptions: Array<{ value: PetType; label: string; description: string }> = [
  { value: 'pig', label: '小猪', description: '温柔放松，可以一起专注、聊聊今天。' },
  { value: 'cat', label: '猫咪', description: '轻盈、灵巧，可以一起专注、记住日常小事。' },
  { value: 'dog', label: '小狗', description: '热情、亲近，可以聊聊今天、一起慢慢成长。' },
]

export default function Account() {
  const { token, user, updatePreferences } = useAuthStore()
  const currentPreference = user?.preferences
  const [petType, setPetType] = useState<PetType>(currentPreference?.pet_type ?? 'pig')
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '' })
  const { release, loading: releaseLoading, error: releaseError, retry: retryRelease } = useDesktopRelease()
  const [prefMessage, setPrefMessage] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [prefError, setPrefError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [savingPreference, setSavingPreference] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const visibleSession = useRef({ token, userId: user?.id ?? null })
  visibleSession.current = { token, userId: user?.id ?? null }
  const [operations] = useState(() => {
    const readSession = () => {
      const state = useAuthStore.getState()
      return matchingUiSession(visibleSession.current, {
        token: state.token, userId: state.user?.id ?? null,
      }, localStorage.getItem('token'))
    }
    return {
      preferences: createAdminOperations(readSession),
      password: createAdminOperations(readSession),
    }
  })

  useEffect(() => {
    Object.values(operations).forEach((operation) => operation.mount())
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      if (next.token !== previous.token || next.user?.id !== previous.user?.id) {
        Object.values(operations).forEach((operation) => operation.invalidate())
        setSavingPreference(false)
        setSavingPassword(false)
        setPrefMessage('')
        setPrefError('')
        setPasswordMessage('')
        setPasswordError('')
        setPasswordForm({ current_password: '', new_password: '' })
      }
    })
    return () => {
      unsubscribe()
      Object.values(operations).forEach((operation) => operation.unmount())
    }
  }, [operations])

  useEffect(() => {
    if (currentPreference) {
      setPetType(currentPreference.pet_type)
    }
  }, [currentPreference])

  const accountMeta = useMemo(
    () => [
      { label: '账户状态', value: user?.status === 'active' ? '启用' : '禁用' },
      {
        label: '最后登录',
        value: user?.last_login_at ? formatApiDateTime(user.last_login_at) : '首次登录后显示',
      },
      {
        label: '创建时间',
        value: formatApiDate(user?.created_at),
      },
    ],
    [user],
  )

  const handlePreferenceSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const operation = operations.preferences.beginMutation()
    if (!operation) return
    setSavingPreference(true)
    setPrefError('')
    setPrefMessage('')
    try {
      const preferences = await userApi.updatePreferences({
        pet_type: petType,
        quick_chat_enabled: currentPreference?.quick_chat_enabled ?? true,
        bubble_frequency: currentPreference?.bubble_frequency ?? 120,
      })
      if (!operation.isCurrent()) return
      updatePreferences(preferences)
      setPrefMessage('桌宠偏好已更新，桌面端下次同步时会生效。')
    } catch (err) {
      if (operation.isCurrent()) setPrefError(getErrorMessage(err, '更新偏好失败。'))
    } finally {
      if (operation.isCurrent()) setSavingPreference(false)
      operation.finish()
    }
  }

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const operation = operations.password.beginMutation()
    if (!operation) return
    setSavingPassword(true)
    setPasswordError('')
    setPasswordMessage('')
    try {
      const response = await authApi.changePassword(passwordForm)
      if (!operation.isCurrent()) return
      setPasswordMessage(response.message)
      setPasswordForm({ current_password: '', new_password: '' })
    } catch (err) {
      if (operation.isCurrent()) setPasswordError(getErrorMessage(err, '修改密码失败。'))
    } finally {
      if (operation.isCurrent()) setSavingPassword(false)
      operation.finish()
    }
  }

  return (
    <div className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
      <section className="space-y-8">
        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Account</div>
          <h1 className="mt-4 text-4xl font-semibold text-slate-950">用户中心</h1>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {accountMeta.map((item) => (
              <div key={item.label} className="rounded-[1.5rem] bg-slate-50 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.label}</div>
                <div className="mt-3 text-sm font-medium text-slate-900">{item.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-medium text-slate-900">{user?.username}</div>
            <div className="mt-1 text-sm text-slate-600">{user?.email}</div>
          </div>
        </article>

        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Desktop Preferences</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">桌宠偏好</h2>

          <form onSubmit={handlePreferenceSubmit} className="mt-6 space-y-5">
            <fieldset disabled={savingPreference} className="space-y-5">
            <legend className="sr-only">桌宠偏好</legend>
            <div className="grid gap-4 md:grid-cols-3">
              {petOptions.map((pet) => (
                <label
                  key={pet.value}
                  className={`cursor-pointer rounded-[1.5rem] border p-4 focus-within:ring-2 focus-within:ring-slate-950 focus-within:ring-offset-2 ${petType === pet.value ? 'border-slate-950 bg-slate-100 ring-1 ring-slate-950' : 'border-slate-200 bg-slate-50'}`}
                >
                  <input
                    type="radio"
                    name="petType"
                    value={pet.value}
                    checked={petType === pet.value}
                    onChange={() => setPetType(pet.value)}
                    className="sr-only"
                  />
                  <div className="text-base font-medium text-slate-900">{pet.label}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-600">{pet.description}</div>
                </label>
              ))}
            </div>

            <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                <div className="font-medium text-slate-900">按你的节奏陪伴</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {petOptions.find((pet) => pet.value === petType)?.label}会结合相处状态和时段主动回应。你可以在桌面主面板的“主动陪伴”中调整陪伴方式；“陪我专注”进行时，它会安静陪着你。
                </p>
            </div>

            {prefError && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{prefError}</div>}
            {prefMessage && <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{prefMessage}</div>}

            <button
              type="submit"
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              {savingPreference ? '保存中...' : '保存偏好'}
            </button>
            </fieldset>
          </form>
        </article>
      </section>

      <section className="space-y-8">
        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Voice Demo</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">AI 语音 Demo</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            进入独立的 RTC 联调页，测试连接、静音、打断、挂断、重连和 AI 远端音频订阅。
          </p>
          <Link
            to="/voice-demo"
            className="mt-6 inline-flex rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            打开语音 Demo
          </Link>
        </article>

        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Security</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">修改密码</h2>

          <form onSubmit={handlePasswordSubmit} className="mt-6 space-y-4">
            <fieldset disabled={savingPassword} className="space-y-4">
            <legend className="sr-only">修改密码</legend>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">当前密码</span>
              <input
                type="password"
                value={passwordForm.current_password}
                autoComplete="current-password"
                onChange={(event) =>
                  setPasswordForm((current) => ({ ...current, current_password: event.target.value }))
                }
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">新密码</span>
              <input
                type="password"
                value={passwordForm.new_password}
                autoComplete="new-password"
                minLength={8}
                maxLength={72}
                onChange={(event) =>
                  setPasswordForm((current) => ({ ...current, new_password: event.target.value }))
                }
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            {passwordError && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{passwordError}</div>}
            {passwordMessage && (
              <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{passwordMessage}</div>
            )}

            <button
              type="submit"
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              {savingPassword ? '更新中...' : '更新密码'}
            </button>
            </fieldset>
          </form>
        </article>

        <article className="rounded-[2rem] border border-slate-200 bg-slate-950 p-8 text-white">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-400">Desktop Release</div>
          <h2 className="mt-4 text-2xl font-semibold">Detachym Windows 客户端</h2>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            当前账号可以直接下载桌宠安装包。本机窗口位置、静音、开机启动等设置保存在客户端本地，桌宠类型和交互偏好会与云端同步。
          </p>

          {releaseLoading ? <p role="status" className="mt-6 text-sm text-slate-300">正在检查发布状态...</p> : release && !releaseError ? (
            <div className="mt-6 space-y-3">
              <div className="text-3xl font-semibold">{release.version}</div>
              <div className="text-sm text-slate-400">{release.filename}</div>
              <a
                href={release.available ? resolveDownloadUrl(release) : undefined}
                aria-disabled={!release.available}
                className={`inline-flex rounded-full px-6 py-3 text-sm font-medium transition ${
                  release.available
                    ? 'bg-white text-slate-950 hover:bg-slate-200'
                    : 'cursor-not-allowed bg-slate-700 text-slate-300'
                }`}
              >
                {release.available ? '下载客户端' : '安装包暂未发布'}
              </a>
            </div>
          ) : (
            <div className="mt-6 text-sm text-slate-300">
              <p role="alert">暂时无法获取版本信息。</p>
              <button type="button" onClick={() => void retryRelease()} className="mt-3 rounded-full border border-slate-400 px-4 py-2">重新检查</button>
            </div>
          )}
        </article>
      </section>
    </div>
  )
}
