import { useCallback, useEffect, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'

import {
  completeReminder,
  getPendingReminders,
} from '../shared/reminders-api'

const REFRESH_INTERVAL_MS = 30000

function getCopy(language) {
  if (language === 'zh-CN') {
    return {
      title: '待处理提醒',
      hint: '小猪提醒过的事项，完成后再增加亲密度。',
      empty: '现在没有待处理事项。',
      delivered: '已提醒',
      refresh: '刷新待处理提醒',
      complete: (title) => `完成：${title}`,
      loadFailed: '待处理提醒加载失败。',
      completeFailed: '提醒完成失败，请稍后重试。',
    }
  }

  return {
    title: 'Pending reminders',
    hint: 'Finish delivered reminders to earn intimacy.',
    empty: 'Nothing is waiting for you.',
    delivered: 'Delivered',
    refresh: 'Refresh pending reminders',
    complete: (title) => `Complete: ${title}`,
    loadFailed: 'Failed to load pending reminders.',
    completeFailed: 'Failed to complete the reminder. Try again.',
  }
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
    if (savingId !== null) {
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
          {reminders.map((reminder) => (
            <div className="pending-reminder-item" key={reminder.id}>
              <div className="pending-reminder-copy">
                <div className="pending-reminder-title">{reminder.title}</div>
                <div className="pending-reminder-time">
                  {copy.delivered} · {formatReminderTime(reminder.remind_at, language)}
                </div>
              </div>
              <button
                type="button"
                className="pending-reminder-complete"
                title={copy.complete(reminder.title)}
                aria-label={copy.complete(reminder.title)}
                disabled={savingId !== null}
                onClick={() => {
                  void handleComplete(reminder)
                }}
              >
                <Check size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
