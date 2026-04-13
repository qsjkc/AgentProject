import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { getErrorMessage } from '../lib/errors'
import { authApi } from '../services'
import { useAuthStore } from '../stores'

type AuthMode = 'login' | 'reset'

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
      setError(getErrorMessage(err, '登录失败，请检查用户名、邮箱或密码。'))
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
      setError(getErrorMessage(err, '发送重置验证码失败。'))
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
      setError(getErrorMessage(err, '重置密码失败。'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[1.75rem] bg-slate-950 p-8 text-white">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-400">Detachym Portal</div>
          <h1 className="mt-6 text-4xl font-semibold">登录云端控制台</h1>
          <p className="mt-4 text-sm leading-7 text-slate-300">
            登录后可以下载桌宠安装包、同步宠物偏好、修改密码，并在管理员账号下查看用户与文档数据。
          </p>
          <div className="mt-10 space-y-3 text-sm text-slate-300">
            <div>1. Web 门户负责注册、登录、下载和账户管理</div>
            <div>2. Windows 客户端负责桌宠、快捷聊天和主面板交互</div>
            <div>3. 所有账户与知识库数据统一由云端 API 承载</div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`rounded-full px-4 py-2 ${mode === 'login' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => setMode('reset')}
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
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
              {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

              <button
                type="submit"
                disabled={loading}
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
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <button
                type="button"
                onClick={handleForgot}
                disabled={sendingCode || isCountingDown}
                className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingCode ? '发送中...' : isCountingDown ? `${formattedTime} 后重试` : '发送验证码'}
              </button>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">验证码</span>
                <input
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  required
                  autoComplete="one-time-code"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
                />
              </label>

              {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
              {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

              <button
                type="submit"
                disabled={loading}
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
