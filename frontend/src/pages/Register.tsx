import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { useAuthFormOperations } from '../hooks/useAuthFormOperations'
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
  const { setToken } = useAuthStore()
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    verification_code: '',
  })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [createdAccount, setCreatedAccount] = useState<{ username: string; password: string } | null>(null)
  const { begin, busy } = useAuthFormOperations()
  const loading = busy === 'submit'
  const sendingCode = busy === 'code'
  const { isCountingDown, formattedTime, start } = useCooldownTimer(180)

  const updateField = (field: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  const handleSendCode = async () => {
    if (createdAccount || isCountingDown) return
    if (!form.email.trim()) {
      setError('请先输入邮箱，再发送验证码。')
      setMessage('')
      return
    }

    const operation = begin('code')
    if (!operation) return
    setError('')
    setMessage('')
    try {
      await authApi.sendVerificationCode(form.email)
      if (!operation.isCurrent()) return
      setMessage('验证码已发送，请检查邮箱。')
      start()
    } catch (err) {
      if (operation.isCurrent()) setError(translateRegisterError(getErrorMessage(err, '验证码发送失败，请稍后重试。')))
    } finally {
      operation.finish()
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (createdAccount) return

    if (form.password.trim().length < 8 || form.password.length > 72) {
      setError('密码需为 8 到 72 位字符。')
      setMessage('')
      return
    }

    const operation = begin('submit')
    if (!operation) return
    const submittedForm = { ...form }
    let registered = false
    setError('')
    setMessage('')
    try {
      await authApi.register(submittedForm)
      registered = true
      if (!operation.isCurrent()) return
      setCreatedAccount({ username: submittedForm.username, password: submittedForm.password })
      setForm((current) => ({ ...current, password: '', verification_code: '' }))
      setMessage('账号已创建，正在为你登录。')
      const token = await authApi.login({
        username: submittedForm.username,
        password: submittedForm.password,
      })
      if (!operation.isCurrent()) return
      setToken(token.access_token)
      navigate('/account', { replace: true })
    } catch (err) {
      if (!operation.isCurrent()) return
      if (registered) {
        setMessage('账号已创建，无需重新注册。')
        setError(getErrorMessage(err, '暂时未能自动登录，请重试登录。'))
      } else {
        setError(translateRegisterError(getErrorMessage(err, '注册失败，请检查输入信息和验证码。')))
      }
    } finally {
      operation.finish()
    }
  }

  const handleRetryLogin = async () => {
    if (!createdAccount) return
    const operation = begin('submit')
    if (!operation) return
    setError('')
    setMessage('账号已创建，正在为你登录。')
    try {
      const token = await authApi.login(createdAccount)
      if (!operation.isCurrent()) return
      setToken(token.access_token)
      navigate('/account', { replace: true })
    } catch (err) {
      if (!operation.isCurrent()) return
      setMessage('账号已创建，无需重新注册。')
      setError(getErrorMessage(err, '暂时无法登录，请稍后重试。'))
    } finally {
      operation.finish()
    }
  }

  return (
    <div className="consumer-auth mx-auto max-w-3xl rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="mb-8">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">YOUR FIRST HELLO</div>
        <h1 className="mt-4 text-4xl font-semibold text-slate-950">从认识彼此开始</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
          创建账号后，小猪会先来陪你。下载 Windows 客户端并登录，就能在桌面见面；也可以在账户里换成喜欢的猫咪或小狗。
        </p>
      </div>

      {createdAccount ? (
        <section className="space-y-5 rounded-[1.5rem] border border-emerald-200 bg-emerald-50 p-6">
          <h2 className="text-xl font-semibold text-slate-950">账号已创建</h2>
          <p className="text-sm leading-6 text-slate-700">欢迎，{createdAccount.username}。你的账号已经准备好了。</p>
          <p role="status" className="text-sm text-emerald-800">{message}</p>
          {error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" onClick={() => void handleRetryLogin()} disabled={Boolean(busy)} className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60">
              {loading ? '登录中...' : '重试登录'}
            </button>
            <Link to="/login" className="text-sm font-medium text-slate-950">前往登录页</Link>
          </div>
        </section>
      ) : <form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-2">
        <fieldset disabled={Boolean(busy)} className="contents">
        <legend className="sr-only">创建账号</legend>
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
              disabled={Boolean(busy) || isCountingDown}
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

        {error && <div role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700 md:col-span-2">{error}</div>}
        {message && <div role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 md:col-span-2">{message}</div>}

        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-4 pt-2">
          <p className="text-sm text-slate-500">
            已有账号？
            <Link to="/login" className="ml-2 font-medium text-slate-950">
              返回登录
            </Link>
          </p>
          <button
            type="submit"
            disabled={Boolean(busy)}
            className="rounded-2xl bg-slate-950 px-6 py-3 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '注册中...' : '创建账号，开始认识'}
          </button>
        </div>
        </fieldset>
      </form>}
    </div>
  )
}
