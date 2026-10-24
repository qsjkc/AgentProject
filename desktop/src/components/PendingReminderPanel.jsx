import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  LoaderCircle,
  Mail,
  MailCheck,
  MailWarning,
  MailX,
  RefreshCw,
  RotateCcw,
  SkipForward,
} from 'lucide-react'

import {
  completeReminder,
  getPendingReminders,
  retryReminderEmail,
  skipReminderOccurrence,
} from '../shared/reminders-api'
import { isPetOnboardingReminderMatch } from '../shared/pet-onboarding-main'
import { captureApiOperationContext } from '../shared/api'
import { commitAccountOperation } from '../shared/pet-account-context'
import { createReminderPanelOperations } from '../shared/reminder-panel-operations'
import { getReminderRecurrenceLabel } from '../shared/reminder-recurrence'
import { UpcomingReminderPanel } from './UpcomingReminderPanel'
import { getPetVisual } from '../shared/pets'
import { t } from '../shared/i18n'

const REFRESH_INTERVAL_MS = 30000

function getCopy(language, petType) {
  if (language === 'zh-CN') {
    return {
      title: '待处理提醒',
      hint: `${t(language, getPetVisual(petType).labelKey)}提醒过的事项，完成后再增加亲密度。`,
      empty: '现在没有待处理事项。想记一件小事，可以在聊天里说“十分钟后提醒我喝水”。',
      delivered: '已提醒',
      emailPending: '邮件待发送',
      emailSending: '邮件发送中',
      emailRetrying: '邮件重试中',
      emailSent: '邮件已发送',
      emailFailed: '邮件发送失败',
      emailDisabled: '未开启邮件',
      emailCanceled: '邮件已取消',
      refresh: '刷新待处理提醒',
      loading: '正在查看待处理提醒…',
      complete: (title) => `完成：${title}`,
      retryEmail: (title) => `重新发送邮件：${title}`,
      skipOccurrence: (title) => `跳过本次：${title}`,
      loadFailed: '待处理提醒加载失败。',
      completeFailed: '提醒完成失败，请稍后重试。',
      retryFailed: '邮件重试启动失败，请稍后再试。',
      skipFailed: '本次提醒跳过失败，请稍后再试。',
      onboardingHint: '事项完成后点一下完成，我就知道这件事收尾了。',
    }
  }

  return {
    title: 'Pending reminders',
    hint: 'Finish delivered reminders to earn intimacy.',
    empty: 'Nothing is waiting for you. To add a reminder, try “十分钟后提醒我喝水” in chat.',
    delivered: 'Delivered',
    emailPending: 'Email pending',
    emailSending: 'Sending email',
    emailRetrying: 'Retrying email',
    emailSent: 'Email sent',
    emailFailed: 'Email failed',
    emailDisabled: 'Email disabled',
    emailCanceled: 'Email canceled',
    refresh: 'Refresh pending reminders',
    loading: 'Checking pending reminders…',
    complete: (title) => `Complete: ${title}`,
    retryEmail: (title) => `Retry email: ${title}`,
    skipOccurrence: (title) => `Skip this occurrence: ${title}`,
    loadFailed: 'Failed to load pending reminders.',
    completeFailed: 'Failed to complete the reminder. Try again.',
    retryFailed: 'Failed to restart email delivery. Try again.',
    skipFailed: 'Failed to skip this occurrence. Try again.',
    onboardingHint: 'When you finish the task, mark it complete so I know this is wrapped up.',
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
  accountContext,
  onCompleted,
  highlightReminderId = null,
}) {
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [retryingId, setRetryingId] = useState(null)
  const [skippingId, setSkippingId] = useState(null)
  const [error, setError] = useState('')
  const currentContextRef = useRef(accountContext)
  const operationsRef = useRef(null)
  if (!operationsRef.current) operationsRef.current = createReminderPanelOperations()
  const { loadGate, actionGate } = operationsRef.current
  currentContextRef.current = accountContext
  const copy = getCopy(language, petType)

  const loadReminders = useCallback(async ({ silent = false } = {}) => {
    const requestContext = operationsRef.current.beginLoad(currentContextRef.current)
    if (!requestContext) return
    if (!silent) {
      setLoading(true)
    }
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      const items = await getPendingReminders(petType, null, true, operationContext)
      commitAccountOperation(
        loadGate,
        requestContext,
        currentContextRef.current,
        () => {
          setReminders(items)
          setError('')
        },
      )
    } catch {
      commitAccountOperation(
        loadGate,
        requestContext,
        currentContextRef.current,
        () => setError(copy.loadFailed),
      )
    } finally {
      commitAccountOperation(
        loadGate,
        requestContext,
        currentContextRef.current,
        () => setLoading(false),
      )
      operationsRef.current.finishLoad(requestContext)
    }
  }, [
    accountContext?.session?.generation,
    accountContext?.session?.token,
    accountContext?.userId,
    accountContext?.epoch,
    copy.loadFailed,
    loadGate,
    petType,
  ])

  useEffect(() => {
    void loadReminders()
    const refresh = () => { void loadReminders({ silent: true }) }
    window.addEventListener('detachym:reminders-changed', refresh)
    const timer = window.setInterval(() => {
      void loadReminders({ silent: true })
    }, REFRESH_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('detachym:reminders-changed', refresh)
    }
  }, [loadReminders])

  useEffect(() => () => {
    operationsRef.current.invalidate()
  }, [
    accountContext?.session?.generation,
    accountContext?.session?.token,
    accountContext?.userId,
    accountContext?.epoch,
    petType,
  ])

  const handleComplete = async (reminder) => {
    if (savingId !== null || retryingId !== null || skippingId !== null) {
      return
    }
    const requestContext = operationsRef.current.beginAction(currentContextRef.current)
    if (!requestContext) return
    setLoading(false)
    setSavingId(reminder.id)
    setError('')
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      const completed = await completeReminder(reminder.id, operationContext)
      if (!commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setReminders((current) => current.filter((item) => item.id !== reminder.id)),
      )) {
        return
      }
      await onCompleted?.(completed, requestContext)
    } catch {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setError(copy.completeFailed),
      )
    } finally {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setSavingId(null),
      )
      operationsRef.current.finishAction(requestContext)
    }
  }

  const handleRetryEmail = async (reminder) => {
    if (savingId !== null || retryingId !== null || skippingId !== null) {
      return
    }
    const requestContext = operationsRef.current.beginAction(currentContextRef.current)
    if (!requestContext) return
    setLoading(false)
    setRetryingId(reminder.id)
    setError('')
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      const updated = await retryReminderEmail(reminder.id, operationContext)
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setReminders((current) => current.map((item) => (
          item.id === reminder.id ? updated : item
        ))),
      )
    } catch {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setError(copy.retryFailed),
      )
    } finally {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setRetryingId(null),
      )
      operationsRef.current.finishAction(requestContext)
    }
  }

  const handleSkipOccurrence = async (reminder) => {
    if (savingId !== null || retryingId !== null || skippingId !== null) {
      return
    }
    const requestContext = operationsRef.current.beginAction(currentContextRef.current)
    if (!requestContext) return
    setLoading(false)
    setSkippingId(reminder.id)
    setError('')
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      await skipReminderOccurrence(reminder.id, operationContext)
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setReminders((current) => current.filter((item) => item.id !== reminder.id)),
      )
    } catch {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setError(copy.skipFailed),
      )
    } finally {
      commitAccountOperation(
        actionGate,
        requestContext,
        currentContextRef.current,
        () => setSkippingId(null),
      )
      operationsRef.current.finishAction(requestContext)
    }
  }

  return (
    <>
    <UpcomingReminderPanel language={language} petType={petType} accountContext={accountContext} />
    <section className="pending-reminder-panel" aria-label={copy.title}>
      <div className="pending-reminder-header">
        <div className="sidebar-title">{copy.title}</div>
        <button
          type="button"
          className="pending-reminder-icon-button"
          data-e2e="pending-reminder-refresh"
          title={copy.refresh}
          aria-label={copy.refresh}
          disabled={loading || savingId !== null || retryingId !== null || skippingId !== null}
          onClick={() => {
            void loadReminders()
          }}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-copy">{copy.hint}</div>

      {loading && <div className="pending-reminder-empty" role="status">{copy.loading}</div>}
      {error && <div className="pending-reminder-error" role="status">{error}</div>}
      {!loading && reminders.length === 0 && !error && (
        <div className="pending-reminder-empty">{copy.empty}</div>
      )}
      {reminders.length > 0 && (
        <div className="pending-reminder-list">
          {reminders.map((reminder) => {
            const isOnboardingHighlight = isPetOnboardingReminderMatch(
              reminder.id,
              highlightReminderId,
            ) && Boolean(reminder.triggered_at)
            const emailDelivery = getEmailDelivery(reminder, copy)
            const EmailIcon = emailDelivery.Icon
            const recurrenceLabel = getReminderRecurrenceLabel(
              reminder.recurrence_type,
              reminder.remind_at,
              language,
            )
            return (
              <div
                className={`pending-reminder-item ${isOnboardingHighlight ? 'is-onboarding-highlight' : ''}`}
                data-e2e-reminder-id={String(reminder.id)}
                key={reminder.id}
                role="group"
                aria-busy={savingId === reminder.id || retryingId === reminder.id || skippingId === reminder.id}
                aria-describedby={isOnboardingHighlight ? `pending-reminder-onboarding-${reminder.id}` : undefined}
              >
                <div className="pending-reminder-copy">
                  <div className="pending-reminder-title">{reminder.title}</div>
                  <div className="pending-reminder-time">
                    {copy.delivered} · {formatReminderTime(reminder.remind_at, language)}
                    {recurrenceLabel ? ` · ${recurrenceLabel}` : ''}
                  </div>
                  <div
                    className={`pending-reminder-email is-${emailDelivery.tone}`}
                    title={emailDelivery.label}
                  >
                    <EmailIcon size={11} aria-hidden="true" />
                    <span>{emailDelivery.label}</span>
                  </div>
                  {isOnboardingHighlight && (
                    <div
                      className="pending-reminder-onboarding-hint"
                      id={`pending-reminder-onboarding-${reminder.id}`}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {copy.onboardingHint}
                    </div>
                  )}
                </div>
                <div className="pending-reminder-actions">
                  {reminder.email_status === 'failed' && (
                    <button
                      type="button"
                      className="pending-reminder-retry"
                      title={copy.retryEmail(reminder.title)}
                      aria-label={copy.retryEmail(reminder.title)}
                      disabled={savingId !== null || retryingId !== null || skippingId !== null}
                      onClick={() => {
                        void handleRetryEmail(reminder)
                      }}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </button>
                  )}
                  {reminder.series_id && (
                    <button
                      type="button"
                      className="pending-reminder-retry"
                      title={copy.skipOccurrence(reminder.title)}
                      aria-label={copy.skipOccurrence(reminder.title)}
                      disabled={savingId !== null || retryingId !== null || skippingId !== null}
                      onClick={() => {
                        void handleSkipOccurrence(reminder)
                      }}
                    >
                      <SkipForward size={15} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`pending-reminder-complete ${isOnboardingHighlight ? 'is-onboarding-highlight' : ''}`}
                    data-e2e-reminder-complete={String(reminder.id)}
                    title={copy.complete(reminder.title)}
                    aria-label={copy.complete(reminder.title)}
                    disabled={savingId !== null || retryingId !== null || skippingId !== null}
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
    </>
  )
}
