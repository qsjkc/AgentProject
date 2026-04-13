import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { getErrorMessage } from '../lib/errors'
import { authApi } from '../services'
import { useAuthStore } from '../stores'

type AuthMode = 'login' | 'reset'

const portalHighlights = [
  '网页负责注册、登录、下载、账户配置与后台入口。',
  '客户端负责透明桌宠、快捷聊天、气泡反馈与主面板交互。',
  '所有账户、偏好和版本信息都通过同一套云端 API 管理。',
]

export default function Login() {
  const navigate = useNavigate()
  const { setToken, setUser } = useAuthStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const { isCountingDown, formattedTime, start } = useCooldownTimer(180)

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')

    try {
      const token = await authApi.login({ username: identifier, password })
      setToken(token.access_token)
      const user = await authApi.getMe()
      setUser(user)
      navigate('/account')
    } catch (err) {
      setError(getErrorMessage(err, '登录失败，请检查用户名、邮箱或密码是否正确。'))
    } finally {
      setLoading(false)
    }
  }

  const handleForgot = async () => {
    if (!email.trim()) {
      setError('请先输入邮箱，再发送验证码。')
      setMessage('')
      return
    }

    setSendingCode(true)
    setError('')
    setMessage('')

    try {
      const response = await authApi.forgotPassword(email)
      setMessage(response.message)
      start()
    } catch (err) {
      setError(getErrorMessage(err, '发送重置验证码失败，请稍后再试。'))
    } finally {
      setSendingCode(false)
    }
  }

  const handleReset = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')

    try {
      const response = await authApi.resetPassword(email, verificationCode, newPassword)
      setMessage(response.message)
      setMode('login')
      setIdentifier(email)
      setPassword('')
      setVerificationCode('')
      setNewPassword('')
    } catch (err) {
      setError(getErrorMessage(err, '重置密码失败，请确认验证码和新密码。'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid gap-8 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="ink-panel reveal-rise rounded-[2.75rem] p-8 md:p-10 xl:p-12">
          <div className="eyebrow eyebrow-light">Detachym Portal</div>
          <h1 className="display-title mt-6">登录你的桌宠云账户</h1>
          <p className="body-copy-light mt-5 max-w-xl text-base">
            当网页与桌面端共享同一套账号、偏好和下载链路时，产品才真正完整。登录之后，你可以继续配置桌宠、修改密码，或者进入后台管理用户。
          </p>

          <div className="mt-10 space-y-4">
            {portalHighlights.map((item, index) => (
              <article
                key={item}
                className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5"
                style={{ animationDelay: `${100 + index * 80}ms` }}
              >
                <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Capability {index + 1}</div>
                <p className="mt-3 text-sm leading-7 text-stone-100">{item}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10" style={{ animationDelay: '140ms' }}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="eyebrow">Account Access</div>
              <h2 className="section-title mt-3 text-stone-950">{mode === 'login' ? '登录' : '重置密码'}</h2>
            </div>

            <div className="inline-flex rounded-full border border-stone-200 bg-white/55 p-1">
              <button
                type="button"
                onClick={() => setMode('login')}
                className={`rounded-full px-4 py-2 text-sm transition ${mode === 'login' ? 'bg-stone-950 text-stone-50' : 'text-stone-600'}`}
              >
                登录
              </button>
              <button
                type="button"
                onClick={() => setMode('reset')}
                className={`rounded-full px-4 py-2 text-sm transition ${mode === 'reset' ? 'bg-stone-950 text-stone-50' : 'text-stone-600'}`}
              >
                找回密码
              </button>
            </div>
          </div>

          <p className="body-copy mt-4 text-sm">
            {mode === 'login'
              ? '使用用户名或邮箱登录，即可进入账户中心和下载页。'
              : '输入邮箱并获取验证码后，你可以在网页端直接完成密码重置。'}
          </p>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              <label className="field-label">
                <span className="field-title">用户名或邮箱</span>
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  required
                  autoComplete="username"
                  className="field-input"
                />
              </label>

              <label className="field-label">
                <span className="field-title">密码</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  className="field-input"
                />
              </label>

              {error && <div className="message-banner message-error">{error}</div>}
              {message && <div className="message-banner message-success">{message}</div>}

              <button type="submit" disabled={loading} className="primary-button w-full text-sm font-medium">
                {loading ? '正在登录...' : '进入账户中心'}
              </button>

              <p className="text-sm text-stone-600">
                还没有账户？
                <Link to="/register" className="action-link ml-2">
                  立即注册
                </Link>
              </p>
            </form>
          ) : (
            <form onSubmit={handleReset} className="mt-8 space-y-5">
              <label className="field-label">
                <span className="field-title">邮箱</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="field-input"
                />
              </label>

              <div className="subtle-panel rounded-[1.7rem] p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-sm font-medium text-stone-950">邮箱验证码</div>
                    <div className="mt-1 text-sm text-stone-600">验证码 180 秒内有效，倒计时结束后可重新发送。</div>
                  </div>
                  <button
                    type="button"
                    onClick={handleForgot}
                    disabled={sendingCode || isCountingDown}
                    className="secondary-button text-sm font-medium"
                  >
                    {sendingCode ? '发送中...' : isCountingDown ? `${formattedTime} 后重试` : '发送验证码'}
                  </button>
                </div>
              </div>

              <label className="field-label">
                <span className="field-title">验证码</span>
                <input
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  required
                  autoComplete="one-time-code"
                  className="field-input"
                />
              </label>

              <label className="field-label">
                <span className="field-title">新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                  className="field-input"
                />
              </label>

              {error && <div className="message-banner message-error">{error}</div>}
              {message && <div className="message-banner message-success">{message}</div>}

              <button type="submit" disabled={loading} className="primary-button w-full text-sm font-medium">
                {loading ? '正在提交...' : '确认重置密码'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  )
}
