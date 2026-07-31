import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  LoaderCircle,
  Mail,
  MailCheck,
  MailWarning,
  MailX,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'

import {
  completeReminder,
  getPendingReminders,
  retryReminderEmail,
} from '../shared/reminders-api'

const REFRESH_INTERVAL_MS = 30000

function getCopy(language) {
  if (language === 'zh-CN') {
    return {
      title: '待处理提醒',
      hint: '小猪提醒过的事项，完成后再增加亲密度。',
      empty: '现在没有待处理事项。',
      delivered: '已提醒',
      emailPending: '邮件待发送',
      emailSending: '邮件发送中',
      emailRetrying: '邮件重试中',
      emailSent: '邮件已发送',
      emailFailed: '邮件发送失败',
      emailDisabled: '未开启邮件',
      emailCanceled: '邮件已取消',
      refresh: '刷新待处理提醒',
      complete: (title) => `完成：${title}`,
      retryEmail: (title) => `重新发送邮件：${title}`,
      loadFailed: '待处理提醒加载失败。',
      completeFailed: '提醒完成失败，请稍后重试。',
      retryFailed: '邮件重试启动失败，请稍后再试。',
    }
  }

  return {
    title: 'Pending reminders',
    hint: 'Finish delivered reminders to earn intimacy.',
    empty: 'Nothing is waiting for you.',
    delivered: 'Delivered',
    emailPending: 'Email pending',
    emailSending: 'Sending email',
    emailRetrying: 'Retrying email',
    emailSent: 'Email sent',
    emailFailed: 'Email failed',
    emailDisabled: 'Email disabled',
    emailCanceled: 'Email canceled',
    refresh: 'Refresh pending reminders',
    complete: (title) => `Complete: ${title}`,
    retryEmail: (title) => `Retry email: ${title}`,
    loadFailed: 'Failed to load pending reminders.',
    completeFailed: 'Failed to complete the reminder. Try again.',
    retryFailed: 'Failed to restart email delivery. Try again.',
  }
}

function getEmailDelivery(reminder, copy) {
  const status = reminder.email_status
  if (status === 'sent') {
    return { Icon: MailCheck, label: copy.emailSent, tone: 'success' }
  }
  if (status === 'sending') {
    return { Icon: LoaderCircle, label: copy.emailSending, tone: 'pending' }
  }
  if (status === 'retrying') {
    return { Icon: MailWarning, label: copy.emailRetrying, tone: 'warning' }
  }
  if (status === 'failed') {
    return { Icon: MailX, label: copy.emailFailed, tone: 'error' }
  }
  if (status === 'disabled') {
    return { Icon: Mail, label: copy.emailDisabled, tone: 'muted' }
  }
  if (status === 'canceled') {
    return { Icon: MailX, label: copy.emailCanceled, tone: 'muted' }
  }
  return { Icon: Mail, label: copy.emailPending, tone: 'pending' }
}

function formatReminderTime(value, language) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function PendingReminderPanel({
  language,
  petType,
  onCompleted,
}) {
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [retryingId, setRetryingId] = useState(null)
  const [error, setError] = useState('')
  const copy = getCopy(language)

  const loadReminders = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
    }
    try {
      const items = await getPendingReminders(petType, null, true)
      setReminders(items)
      setError('')
    } catch {
      setError(copy.loadFailed)
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }, [copy.loadFailed, petType])

  useEffect(() => {
    void loadReminders()
    const timer = window.setInterval(() => {
      void loadReminders({ silent: true })
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadReminders])

  const handleComplete = async (reminder) => {
    if (savingId !== null || retryingId !== null) {
      return
    }
    setSavingId(reminder.id)
    setError('')
    try {
      const completed = await completeReminder(reminder.id)
      setReminders((current) => current.filter((item) => item.id !== reminder.id))
      await onCompleted?.(completed)
    } catch {
      setError(copy.completeFailed)
    } finally {
      setSavingId(null)
    }
  }

  const handleRetryEmail = async (reminder) => {
    if (savingId !== null || retryingId !== null) {
      return
    }
    setRetryingId(reminder.id)
    setError('')
    try {
      const updated = await retryReminderEmail(reminder.id)
      setReminders((current) => current.map((item) => (
        item.id === reminder.id ? updated : item
      )))
    } catch {
      setError(copy.retryFailed)
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <section className="pending-reminder-panel" aria-label={copy.title}>
      <div className="pending-reminder-header">
        <div className="sidebar-title">{copy.title}</div>
        <button
          type="button"
          className="pending-reminder-icon-button"
          title={copy.refresh}
          aria-label={copy.refresh}
          disabled={loading}
          onClick={() => {
            void loadReminders()
          }}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-copy">{copy.hint}</div>

      {error && <div className="pending-reminder-error" role="status">{error}</div>}
      {!loading && reminders.length === 0 && !error && (
        <div className="pending-reminder-empty">{copy.empty}</div>
      )}
      {reminders.length > 0 && (
        <div className="pending-reminder-list">
          {reminders.map((reminder) => {
            const emailDelivery = getEmailDelivery(reminder, copy)
            const EmailIcon = emailDelivery.Icon
            return (
              <div className="pending-reminder-item" key={reminder.id}>
                <div className="pending-reminder-copy">
                  <div className="pending-reminder-title">{reminder.title}</div>
                  <div className="pending-reminder-time">
                    {copy.delivered} · {formatReminderTime(reminder.remind_at, language)}
                  </div>
                  <div
                    className={`pending-reminder-email is-${emailDelivery.tone}`}
                    title={emailDelivery.label}
                  >
                    <EmailIcon size={11} aria-hidden="true" />
                    <span>{emailDelivery.label}</span>
                  </div>
                </div>
                <div className="pending-reminder-actions">
                  {reminder.email_status === 'failed' && (
                    <button
                      type="button"
                      className="pending-reminder-retry"
                      title={copy.retryEmail(reminder.title)}
                      aria-label={copy.retryEmail(reminder.title)}
                      disabled={savingId !== null || retryingId !== null}
                      onClick={() => {
                        void handleRetryEmail(reminder)
                      }}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="pending-reminder-complete"
                    title={copy.complete(reminder.title)}
                    aria-label={copy.complete(reminder.title)}
                    disabled={savingId !== null || retryingId !== null}
                    onClick={() => {
                      void handleComplete(reminder)
                    }}
                  >
                    <Check size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
