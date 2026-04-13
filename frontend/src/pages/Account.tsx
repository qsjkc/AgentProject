import { FormEvent, useEffect, useMemo, useState } from 'react'

import { getErrorMessage } from '../lib/errors'
import { authApi, publicApi, resolveDownloadUrl, userApi } from '../services'
import { useAuthStore } from '../stores'
import type { DesktopRelease, PetType } from '../types'

const petOptions: Array<{ value: PetType; label: string; description: string; summary: string }> = [
  { value: 'cat', label: '灵巧猫咪', summary: '轻盈安静', description: '适合长期驻留桌面，反馈轻快，整体气质更克制。' },
  { value: 'dog', label: '陪伴小狗', summary: '直接热情', description: '强调陪伴感与快捷聊天入口，适合高频互动。' },
  { value: 'pig', label: '治愈小猪', summary: '柔和松弛', description: '更适合搭配气泡反馈与情绪状态变化。' },
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
  const [prefError, setPrefError] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordError, setPasswordError] = useState('')

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
        label: '最近登录',
        value: user?.last_login_at ? new Date(user.last_login_at).toLocaleString('zh-CN') : '首次登录后显示',
      },
      {
        label: '创建时间',
        value: user?.created_at ? new Date(user.created_at).toLocaleDateString('zh-CN') : '-',
      },
    ],
    [user],
  )

  const handlePreferenceSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setPrefError('')
    setPrefMessage('')

    try {
      const preferences = await userApi.updatePreferences({
        pet_type: petType,
        quick_chat_enabled: quickChatEnabled,
        bubble_frequency: bubbleFrequency,
      })
      updatePreferences(preferences)
      setPrefMessage('桌宠偏好已更新，客户端下次拉取配置时会自动生效。')
    } catch (err) {
      setPrefError(getErrorMessage(err, '更新桌宠偏好失败，请稍后重试。'))
    }
  }

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setPasswordError('')
    setPasswordMessage('')

    try {
      const response = await authApi.changePassword(passwordForm)
      setPasswordMessage(response.message)
      setPasswordForm({ current_password: '', new_password: '' })
    } catch (err) {
      setPasswordError(getErrorMessage(err, '修改密码失败，请检查当前密码。'))
    }
  }

  const publishedAt = release?.published_at
    ? new Date(release.published_at).toLocaleString('zh-CN')
    : '当前未记录发布时间'

  return (
    <div className="space-y-10 lg:space-y-14">
      <section className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10 xl:p-12">
        <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="eyebrow">Account Center</div>
            <h1 className="section-title mt-4 text-stone-950">欢迎回来，{user?.username}</h1>
            <p className="body-copy mt-4 max-w-2xl text-sm">
              这里是网页端的主控制台。你可以继续同步桌宠偏好、修改密码、查看安装包版本，并保持网页账户与桌面客户端使用同一套身份体系。
            </p>
          </div>

          <div className="subtle-panel rounded-[1.8rem] p-5 xl:max-w-sm">
            <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-500">Profile</div>
            <div className="mt-3 text-xl font-semibold text-stone-950">{user?.username}</div>
            <div className="mt-2 text-sm text-stone-600">{user?.email}</div>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {accountMeta.map((item, index) => (
            <article
              key={item.label}
              className="subtle-panel reveal-rise rounded-[1.7rem] p-5"
              style={{ animationDelay: `${120 + index * 90}ms` }}
            >
              <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-500">{item.label}</div>
              <div className="mt-3 text-lg font-semibold text-stone-950">{item.value}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.08fr_0.92fr]">
        <article className="surface-panel reveal-rise rounded-[2.5rem] p-8 md:p-10" style={{ animationDelay: '120ms' }}>
          <div className="eyebrow">Desktop Preferences</div>
          <h2 className="section-title mt-4 text-stone-950">桌宠偏好设置</h2>
          <p className="body-copy mt-4 text-sm">
            这一部分只管理会被桌面端读取的云端偏好，不改变客户端本机保存的窗口位置和静音等设置。
          </p>

          <form onSubmit={handlePreferenceSubmit} className="mt-8 space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              {petOptions.map((pet) => {
                const active = petType === pet.value
                return (
                  <label
                    key={pet.value}
                    className={[
                      'cursor-pointer rounded-[1.8rem] border p-5 transition-all duration-200',
                      active
                        ? 'border-stone-950 bg-stone-950 text-stone-50 shadow-[0_18px_40px_rgba(24,19,15,0.18)]'
                        : 'border-stone-200 bg-white/55 text-stone-900 hover:border-stone-400 hover:bg-white/72',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="petType"
                      value={pet.value}
                      checked={active}
                      onChange={() => setPetType(pet.value)}
                      className="sr-only"
                    />
                    <div className={`text-[0.72rem] uppercase tracking-[0.32em] ${active ? 'text-stone-300' : 'text-stone-500'}`}>
                      {pet.summary}
                    </div>
                    <div className="mt-3 text-2xl font-semibold">{pet.label}</div>
                    <div className={`mt-3 text-sm leading-7 ${active ? 'text-stone-200' : 'text-stone-600'}`}>
                      {pet.description}
                    </div>
                  </label>
                )
              })}
            </div>

            <label className="subtle-panel flex items-center justify-between gap-6 rounded-[1.8rem] p-5">
              <div>
                <div className="text-lg font-semibold text-stone-950">启用快捷聊天</div>
                <div className="mt-2 text-sm leading-7 text-stone-600">
                  控制点击桌宠后是否默认弹出快捷聊天窗口。
                </div>
              </div>
              <input
                type="checkbox"
                checked={quickChatEnabled}
                onChange={(event) => setQuickChatEnabled(event.target.checked)}
                className="h-5 w-5 rounded border-stone-300"
              />
            </label>

            <label className="field-label subtle-panel rounded-[1.8rem] p-5">
              <span className="field-title">气泡频率（秒）</span>
              <input
                type="number"
                min={30}
                max={3600}
                value={bubbleFrequency}
                onChange={(event) => setBubbleFrequency(Number(event.target.value))}
                className="field-input"
              />
              <span className="field-note">建议控制在 60 到 300 秒之间，避免桌面提示过于频繁。</span>
            </label>

            {prefError && <div className="message-banner message-error">{prefError}</div>}
            {prefMessage && <div className="message-banner message-success">{prefMessage}</div>}

            <button type="submit" className="primary-button text-sm font-medium">
              保存桌宠偏好
            </button>
          </form>
        </article>

        <div className="space-y-6">
          <article className="surface-panel reveal-rise rounded-[2.5rem] p-8 md:p-10" style={{ animationDelay: '200ms' }}>
            <div className="eyebrow">Security</div>
            <h2 className="section-title mt-4 text-stone-950">账户安全</h2>
            <p className="body-copy mt-4 text-sm">密码更新仍然沿用现有接口，只优化页面表达和反馈层次。</p>

            <form onSubmit={handlePasswordSubmit} className="mt-8 space-y-5">
              <label className="field-label">
                <span className="field-title">当前密码</span>
                <input
                  type="password"
                  value={passwordForm.current_password}
                  onChange={(event) =>
                    setPasswordForm((current) => ({ ...current, current_password: event.target.value }))
                  }
                  required
                  className="field-input"
                />
              </label>

              <label className="field-label">
                <span className="field-title">新密码</span>
                <input
                  type="password"
                  value={passwordForm.new_password}
                  onChange={(event) =>
                    setPasswordForm((current) => ({ ...current, new_password: event.target.value }))
                  }
                  required
                  className="field-input"
                />
              </label>

              {passwordError && <div className="message-banner message-error">{passwordError}</div>}
              {passwordMessage && <div className="message-banner message-success">{passwordMessage}</div>}

              <button type="submit" className="primary-button text-sm font-medium">
                更新密码
              </button>
            </form>
          </article>

          <article className="ink-panel reveal-rise rounded-[2.5rem] p-8 md:p-10" style={{ animationDelay: '280ms' }}>
            <div className="eyebrow eyebrow-light">Desktop Release</div>
            <h2 className="section-title mt-4">当前可下载的桌面版本</h2>
            <p className="body-copy-light mt-4 text-sm">
              账户中心同样会读取公开版本接口，方便你在登录后直接进入下载，不必再回到首页。
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
                <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Version</div>
                <div className="mt-3 font-display text-5xl leading-none">{release?.available ? release.version : '待发布'}</div>
              </div>
              <div className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
                <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Published</div>
                <div className="mt-3 text-sm leading-7 text-stone-200">{publishedAt}</div>
              </div>
            </div>

            <div className="mt-6 rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
              <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Filename</div>
              <div className="mt-3 text-sm leading-7 text-stone-100">
                {release?.filename ?? '当前没有可公开下载的安装包。'}
              </div>
            </div>

            <div className="mt-6">
              <a
                href={release?.available ? resolveDownloadUrl(release) : '#'}
                className="ghost-button text-sm font-medium"
              >
                {release?.available ? '下载客户端' : '安装包暂未发布'}
              </a>
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
