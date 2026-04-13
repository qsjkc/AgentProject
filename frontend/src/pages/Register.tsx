import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { getErrorMessage } from '../lib/errors'
import { authApi } from '../services'
import { useAuthStore } from '../stores'

function translateRegisterError(message: string) {
  const normalized = message.toLowerCase()

  if (normalized.includes('email already registered')) {
    return '该邮箱已注册，请直接登录或使用找回密码。'
  }

  if (normalized.includes('username already registered')) {
    return '该用户名已被占用，请更换后重试。'
  }

  if (normalized.includes('verification code')) {
    return '验证码无效或已过期，请重新获取。'
  }

  return message
}

export default function Register() {
  const navigate = useNavigate()
  const { setToken, setUser } = useAuthStore()
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    verification_code: '',
  })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const { isCountingDown, formattedTime, start } = useCooldownTimer(180)

  const updateField = (field: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  const handleSendCode = async () => {
    if (!form.email.trim()) {
      setError('请先输入邮箱，再发送验证码。')
      setMessage('')
      return
    }

    setSendingCode(true)
    setError('')
    setMessage('')
    try {
      await authApi.sendVerificationCode(form.email)
      setMessage('验证码已发送，请检查邮箱。')
      start()
    } catch (err) {
      setError(translateRegisterError(getErrorMessage(err, '验证码发送失败，请稍后重试。')))
    } finally {
      setSendingCode(false)
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()

    if (form.password.trim().length < 8 || form.password.length > 72) {
      setError('密码需为 8 到 72 位字符。')
      setMessage('')
      return
    }

    setLoading(true)
    setError('')
    setMessage('')
    try {
      await authApi.register(form)
      const token = await authApi.login({
        username: form.username,
        password: form.password,
      })
      setToken(token.access_token)
      const user = await authApi.getMe()
      setUser(user)
      navigate('/account')
    } catch (err) {
      setToken(null)
      setUser(null)
      setError(translateRegisterError(getErrorMessage(err, '注册失败，请检查输入信息和验证码。')))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="mb-8">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Account Register</div>
        <h1 className="mt-4 text-4xl font-semibold text-slate-950">创建 Detachym 账号</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
          注册完成后会自动进入用户中心，你可以继续配置桌宠偏好并下载 Windows 安装包。
        </p>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-2">
        <label className="block md:col-span-1">
          <span className="mb-2 block text-sm text-slate-600">用户名</span>
          <input
            value={form.username}
            onChange={(event) => updateField('username', event.target.value)}
            required
            minLength={3}
            autoComplete="username"
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          />
        </label>

        <label className="block md:col-span-1">
          <span className="mb-2 block text-sm text-slate-600">邮箱</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => updateField('email', event.target.value)}
            required
            autoComplete="email"
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          />
        </label>

        <div className="md:col-span-2 grid gap-4 md:grid-cols-[1fr_auto]">
          <label className="block">
            <span className="mb-2 block text-sm text-slate-600">验证码</span>
            <input
              value={form.verification_code}
              onChange={(event) => updateField('verification_code', event.target.value)}
              required
              minLength={6}
              maxLength={6}
              autoComplete="one-time-code"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleSendCode}
              disabled={sendingCode || isCountingDown}
              className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sendingCode ? '发送中...' : isCountingDown ? `${formattedTime} 后重试` : '发送验证码'}
            </button>
          </div>
        </div>

        <label className="block md:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-4">
            <span className="block text-sm text-slate-600">密码</span>
            <span className="text-xs text-slate-400">8-72 位字符</span>
          </div>
          <input
            type="password"
            value={form.password}
            onChange={(event) => updateField('password', event.target.value)}
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950"
          />
          <p className="mt-2 text-xs leading-6 text-slate-500">建议使用字母、数字和符号组合，方便后续长期使用。</p>
        </label>

        {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700 md:col-span-2">{error}</div>}
        {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 md:col-span-2">{message}</div>}

        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-4 pt-2">
          <p className="text-sm text-slate-500">
            已有账号？
            <Link to="/login" className="ml-2 font-medium text-slate-950">
              返回登录
            </Link>
          </p>
          <button
            type="submit"
            disabled={loading}
            className="rounded-2xl bg-slate-950 px-6 py-3 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '注册中...' : '注册并进入控制台'}
          </button>
        </div>
      </form>
    </div>
  )
}
