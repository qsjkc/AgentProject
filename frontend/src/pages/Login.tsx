import { FormEvent, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { useAuthFormOperations } from '../hooks/useAuthFormOperations'
import { getErrorMessage } from '../lib/errors'
import { getLoginDestination } from '../lib/auth'
import { authApi } from '../services'
import { useAuthStore } from '../stores'

type AuthMode = 'login' | 'reset'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setToken } = useAuthStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const { begin, invalidate, busy } = useAuthFormOperations()
  const loading = busy === 'submit'
  const sendingCode = busy === 'code'
  const { isCountingDown, formattedTime, start } = useCooldownTimer(180)

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault()
    const operation = begin('submit')
    if (!operation) return
    setError('')
    setMessage('')

    try {
      const token = await authApi.login({ username: identifier, password })
      if (!operation.isCurrent()) return
      setToken(token.access_token)
      navigate(getLoginDestination(location.state?.from), { replace: true })
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '登录失败，请检查用户名、邮箱或密码。'))
    } finally {
      operation.finish()
    }
  }

  const handleForgot = async () => {
    if (isCountingDown) return
    if (!email.trim()) {
      setError('请先输入邮箱，再发送验证码。')
      setMessage('')
      return
    }

    const operation = begin('code')
    if (!operation) return
    setError('')
    setMessage('')

    try {
      const response = await authApi.forgotPassword(email)
      if (!operation.isCurrent()) return
      setMessage(response.message)
      start()
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '发送重置验证码失败。'))
    } finally {
      operation.finish()
    }
  }

  const handleReset = async (event: FormEvent) => {
    event.preventDefault()
    const operation = begin('submit')
    if (!operation) return
    setError('')
    setMessage('')

    try {
      const response = await authApi.resetPassword(email, verificationCode, newPassword)
      if (!operation.isCurrent()) return
      setMessage(response.message)
      setMode('login')
      setIdentifier(email)
      setPassword('')
      setVerificationCode('')
      setNewPassword('')
    } catch (err) {
      if (operation.isCurrent()) setError(getErrorMessage(err, '重置密码失败。'))
    } finally {
      operation.finish()
    }
  }

  const switchMode = (nextMode: AuthMode) => {
    if (nextMode === mode) return
    invalidate()
    setMode(nextMode)
    setError('')
    setMessage('')
  }

  return (
    <div className="consumer-auth mx-auto max-w-4xl rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="auth-welcome rounded-[1.75rem] p-8">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-400">A LITTLE FRIEND IS WAITING</div>
          <h1 className="mt-6 text-4xl font-semibold">和小伙伴，重新见面。</h1>
          <p className="mt-4 text-sm leading-7 text-slate-300">
            登录你的 Detachym 账号，继续管理桌宠偏好。把小猪带到桌面，让每次回来都有一点熟悉的回应。
          </p>
          <div className="mt-10 space-y-3 text-sm text-slate-300">
            <div>摸摸它，给平常的一天一点回应。</div>
            <div>相处慢慢积累，不用急着完成什么。</div>
            <div>安装 Windows 客户端，就能开始陪伴。</div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1 text-sm">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`rounded-full px-4 py-2 ${mode === 'login' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => switchMode('reset')}
              className={`rounded-full px-4 py-2 ${mode === 'reset' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              重置密码
            </button>
          </div>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">用户名或邮箱</span>
                <input
                  value={identifier}
                  disabled={Boolean(busy)}
                  onChange={(event) => setIdentifier(event.target.value)}
                  required
                  autoComplete="username"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">密码</span>
                <input
                  type="password"
                  value={password}
                  disabled={Boolean(busy)}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              {error && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
              {message && <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

              <button
                type="submit"
                disabled={Boolean(busy)}
                className="w-full rounded-2xl bg-slate-950 px-4 py-3 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? '登录中...' : '登录'}
              </button>

              <p className="text-sm text-slate-500">
                还没有账号？
                <Link to="/register" className="ml-2 font-medium text-slate-950">
                  立即注册
                </Link>
              </p>
            </form>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">邮箱</span>
                <input
                  type="email"
                  value={email}
                  disabled={Boolean(busy)}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <button
                type="button"
                onClick={handleForgot}
                disabled={Boolean(busy) || isCountingDown}
                className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingCode ? '发送中...' : isCountingDown ? `${formattedTime} 后重试` : '发送验证码'}
              </button>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">验证码</span>
                <input
                  value={verificationCode}
                  disabled={Boolean(busy)}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  required
                  autoComplete="one-time-code"
                  minLength={6}
                  maxLength={6}
                  inputMode="numeric"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  disabled={Boolean(busy)}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={72}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              {error && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
              {message && <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

              <button
                type="submit"
                disabled={Boolean(busy)}
                className="w-full rounded-2xl bg-slate-950 px-4 py-3 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? '提交中...' : '重置密码'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
