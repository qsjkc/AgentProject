import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCooldownTimer } from '../hooks/useCooldownTimer'
import { getErrorMessage } from '../lib/errors'
import { authApi } from '../services'
import { useAuthStore } from '../stores'

const onboardingSteps = [
  '输入邮箱获取验证码，完成基础身份验证。',
  '注册完成后会自动登录并跳转到账户中心。',
  '进入账户中心后即可同步桌宠偏好并下载客户端。',
]

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
      const response = await authApi.sendVerificationCode(form.email)
      setMessage(response.message)
      start()
    } catch (err) {
      setError(getErrorMessage(err, '发送验证码失败，请稍后重试。'))
    } finally {
      setSendingCode(false)
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
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
      setError(getErrorMessage(err, '注册失败，请检查输入信息和验证码。'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid gap-8 xl:grid-cols-[0.88fr_1.12fr]">
        <section className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10 xl:p-12">
          <div className="eyebrow">Create Account</div>
          <h1 className="section-title mt-4 text-stone-950">创建你的 Detachym 账户</h1>
          <p className="body-copy mt-4 max-w-xl text-sm">
            注册页会保持流程极短，但观感必须像完整品牌体验。注册成功后，你会自动进入账户中心，不再停留在中间空白状态。
          </p>

          <div className="mt-8 space-y-4">
            {onboardingSteps.map((step, index) => (
              <article key={step} className="subtle-panel rounded-[1.7rem] p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-300/50 bg-amber-100/60 text-sm font-semibold text-amber-900">
                    {index + 1}
                  </div>
                  <p className="text-sm leading-7 text-stone-700">{step}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="mt-8 text-sm text-stone-600">
            已有账户？
            <Link to="/login" className="action-link ml-2">
              返回登录
            </Link>
          </div>
        </section>

        <section className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10" style={{ animationDelay: '140ms' }}>
          <div className="eyebrow">Registration Form</div>
          <h2 className="section-title mt-4 text-stone-950">完成注册后直接进入控制台</h2>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-5 md:grid-cols-2">
            <label className="field-label">
              <span className="field-title">用户名</span>
              <input
                value={form.username}
                onChange={(event) => updateField('username', event.target.value)}
                required
                autoComplete="username"
                className="field-input"
              />
            </label>

            <label className="field-label">
              <span className="field-title">邮箱</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => updateField('email', event.target.value)}
                required
                autoComplete="email"
                className="field-input"
              />
            </label>

            <div className="md:col-span-2 grid gap-4 md:grid-cols-[1fr_auto]">
              <label className="field-label">
                <span className="field-title">验证码</span>
                <input
                  value={form.verification_code}
                  onChange={(event) => updateField('verification_code', event.target.value)}
                  required
                  autoComplete="one-time-code"
                  className="field-input"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={sendingCode || isCountingDown}
                  className="secondary-button w-full text-sm font-medium md:min-w-[170px]"
                >
                  {sendingCode ? '发送中...' : isCountingDown ? `${formattedTime} 后重试` : '发送验证码'}
                </button>
              </div>
            </div>

            <label className="field-label md:col-span-2">
              <span className="field-title">密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => updateField('password', event.target.value)}
                required
                autoComplete="new-password"
                className="field-input"
              />
              <span className="field-note">建议使用 8 位以上密码，注册成功后可在账户中心随时修改。</span>
            </label>

            {error && <div className="message-banner message-error md:col-span-2">{error}</div>}
            {message && <div className="message-banner message-success md:col-span-2">{message}</div>}

            <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-4 pt-2">
              <p className="text-sm text-stone-600">提交后会自动登录，并进入账户中心。</p>
              <button type="submit" disabled={loading} className="primary-button text-sm font-medium">
                {loading ? '正在注册...' : '注册并进入控制台'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
