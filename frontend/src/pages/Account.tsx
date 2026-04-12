import { FormEvent, useEffect, useMemo, useState } from 'react'

import { getErrorMessage } from '../lib/errors'
import { authApi, publicApi, resolveDownloadUrl, userApi } from '../services'
import { useAuthStore } from '../stores'
import type { DesktopRelease, PetType } from '../types'

const petOptions: Array<{ value: PetType; label: string; description: string }> = [
  { value: 'cat', label: '猫咪', description: '轻量、灵巧，适合长时间驻留桌面。' },
  { value: 'dog', label: '小狗', description: '强调陪伴感和快捷聊天入口。' },
  { value: 'pig', label: '小猪', description: '偏休闲表达，适合动态气泡。' },
]

export default function Account() {
  const { user, updatePreferences } = useAuthStore()
  const currentPreference = user?.preferences
  const [petType, setPetType] = useState<PetType>(currentPreference?.pet_type ?? 'cat')
  const [quickChatEnabled, setQuickChatEnabled] = useState(currentPreference?.quick_chat_enabled ?? true)
  const [bubbleFrequency, setBubbleFrequency] = useState(currentPreference?.bubble_frequency ?? 120)
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '' })
  const [release, setRelease] = useState<DesktopRelease | null>(null)
  const [prefMessage, setPrefMessage] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (currentPreference) {
      setPetType(currentPreference.pet_type)
      setQuickChatEnabled(currentPreference.quick_chat_enabled)
      setBubbleFrequency(currentPreference.bubble_frequency)
    }
  }, [currentPreference])

  useEffect(() => {
    publicApi.getWindowsRelease().then(setRelease).catch(() => setRelease(null))
  }, [])

  const accountMeta = useMemo(
    () => [
      { label: '账户状态', value: user?.status === 'active' ? '启用' : '禁用' },
      {
        label: '最后登录',
        value: user?.last_login_at ? new Date(user.last_login_at).toLocaleString() : '首次登录后显示',
      },
      {
        label: '创建时间',
        value: user?.created_at ? new Date(user.created_at).toLocaleDateString() : '-',
      },
    ],
    [user],
  )

  const handlePreferenceSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setPrefMessage('')
    try {
      const preferences = await userApi.updatePreferences({
        pet_type: petType,
        quick_chat_enabled: quickChatEnabled,
        bubble_frequency: bubbleFrequency,
      })
      updatePreferences(preferences)
      setPrefMessage('桌宠偏好已更新，桌面端下次拉取配置时会生效。')
    } catch (err) {
      setError(getErrorMessage(err, '更新偏好失败。'))
    }
  }

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setPasswordMessage('')
    try {
      const response = await authApi.changePassword(passwordForm)
      setPasswordMessage(response.message)
      setPasswordForm({ current_password: '', new_password: '' })
    } catch (err) {
      setError(getErrorMessage(err, '修改密码失败。'))
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
            <div className="grid gap-4 md:grid-cols-3">
              {petOptions.map((pet) => (
                <label
                  key={pet.value}
                  className="cursor-pointer rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4"
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

            <label className="flex items-center justify-between rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="font-medium text-slate-900">启用快捷聊天</div>
                <div className="mt-1 text-sm text-slate-600">控制桌宠点击后是否默认展示快捷聊天窗。</div>
              </div>
              <input
                type="checkbox"
                checked={quickChatEnabled}
                onChange={(event) => setQuickChatEnabled(event.target.checked)}
                className="h-5 w-5 rounded border-slate-300"
              />
            </label>

            <label className="block rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
              <span className="text-sm font-medium text-slate-900">气泡频率（秒）</span>
              <input
                type="number"
                min={30}
                max={3600}
                value={bubbleFrequency}
                onChange={(event) => setBubbleFrequency(Number(event.target.value))}
                className="mt-3 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
            {prefMessage && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{prefMessage}</div>}

            <button
              type="submit"
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              保存偏好
            </button>
          </form>
        </article>
      </section>

      <section className="space-y-8">
        <article className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Security</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">修改密码</h2>

          <form onSubmit={handlePasswordSubmit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm text-slate-600">当前密码</span>
              <input
                type="password"
                value={passwordForm.current_password}
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
                onChange={(event) =>
                  setPasswordForm((current) => ({ ...current, new_password: event.target.value }))
                }
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
              />
            </label>

            {passwordMessage && (
              <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{passwordMessage}</div>
            )}

            <button
              type="submit"
              className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              更新密码
            </button>
          </form>
        </article>

        <article className="rounded-[2rem] border border-slate-200 bg-slate-950 p-8 text-white">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-400">Desktop Release</div>
          <h2 className="mt-4 text-2xl font-semibold">Detachym Windows 客户端</h2>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            当前账户可以直接下载桌宠安装包。桌宠本机设置保存在客户端，宠物类型和交互偏好与云端同步。
          </p>

          {release ? (
            <div className="mt-6 space-y-3">
              <div className="text-3xl font-semibold">{release.version}</div>
              <div className="text-sm text-slate-400">{release.filename}</div>
              <a
                href={release.available ? resolveDownloadUrl(release) : '#'}
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
            <div className="mt-6 text-sm text-slate-300">暂时无法获取版本信息。</div>
          )}
        </article>
      </section>
    </div>
  )
}
