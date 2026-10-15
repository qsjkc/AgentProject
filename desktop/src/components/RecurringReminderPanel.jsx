import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pause,
  Play,
  RefreshCw,
  Repeat2,
  Trash2,
} from 'lucide-react'

import {
  cancelReminderSeries,
  getReminderSeries,
  pauseReminderSeries,
  resumeReminderSeries,
} from '../shared/reminders-api'
import { runAccountOperation } from '../shared/pet-account-context'
import { createReminderPanelOperations } from '../shared/reminder-panel-operations'
import { formatReminderSeriesSchedule } from '../shared/reminder-schedule'
import { captureApiOperationContext } from '../shared/api'

const REFRESH_INTERVAL_MS = 30000

function getCopy(language) {
  if (language === 'zh-CN') {
    return {
      title: '重复提醒',
      empty: '还没有重复提醒。',
      active: '进行中',
      paused: '已暂停',
      daily: '每天',
      weekdays: '工作日',
      weekly: '每周',
      refresh: '刷新重复提醒',
      loading: '正在查看重复提醒…',
      pause: (title) => `暂停：${title}`,
      resume: (title) => `恢复：${title}`,
      cancel: (title) => `终止：${title}`,
      confirmCancel: (title) => `确定终止重复提醒“${title}”吗？已完成记录会保留。`,
      loadFailed: '重复提醒加载失败。',
      updateFailed: '重复提醒更新失败，请稍后再试。',
    }
  }
  return {
    title: 'Recurring reminders',
    empty: 'No recurring reminders yet.',
    active: 'Active',
    paused: 'Paused',
    daily: 'Daily',
    weekdays: 'Weekdays',
    weekly: 'Weekly',
    refresh: 'Refresh recurring reminders',
    loading: 'Checking recurring reminders…',
    pause: (title) => `Pause: ${title}`,
    resume: (title) => `Resume: ${title}`,
    cancel: (title) => `End: ${title}`,
    confirmCancel: (title) => `End “${title}”? Completed history will be kept.`,
    loadFailed: 'Failed to load recurring reminders.',
    updateFailed: 'Failed to update the recurring reminder. Try again.',
  }
}

export function RecurringReminderPanel({ language, petType, accountContext, onUpdated }) {
  const [seriesItems, setSeriesItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [error, setError] = useState('')
  const currentContextRef = useRef(accountContext)
  const operationsRef = useRef(null)
  if (!operationsRef.current) operationsRef.current = createReminderPanelOperations()
  const { loadGate, actionGate } = operationsRef.current
  currentContextRef.current = accountContext
  const copy = getCopy(language)

  const loadSeries = useCallback(async ({ silent = false } = {}) => {
    const requestContext = operationsRef.current.beginLoad(currentContextRef.current)
    if (!requestContext) return
    if (!silent) {
      setLoading(true)
    }
    await runAccountOperation({
      gate: loadGate,
      requestContext,
      getCurrentContext: () => currentContextRef.current,
      operation: async () => getReminderSeries(
        petType,
        await captureApiOperationContext(requestContext, 'pet'),
      ),
      onSuccess: (items) => {
        setSeriesItems(items.filter((item) => item.status !== 'canceled'))
        setError('')
      },
      onError: () => setError(copy.loadFailed),
      onFinally: () => setLoading(false),
    })
    operationsRef.current.finishLoad(requestContext)
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
    void loadSeries()
    const handleSeriesChanged = () => {
      void loadSeries({ silent: true })
    }
    window.addEventListener('detachym:reminder-series-changed', handleSeriesChanged)
    const timer = window.setInterval(() => {
      void loadSeries({ silent: true })
    }, REFRESH_INTERVAL_MS)
    return () => {
      window.removeEventListener('detachym:reminder-series-changed', handleSeriesChanged)
      window.clearInterval(timer)
    }
  }, [loadSeries])

  useEffect(() => () => {
    operationsRef.current.invalidate()
  }, [
    accountContext?.session?.generation,
    accountContext?.session?.token,
    accountContext?.userId,
    accountContext?.petType,
    accountContext?.epoch,
  ])

  const updateSeries = async (series, action) => {
    if (savingId !== null) {
      return
    }
    const requestContext = operationsRef.current.beginAction(currentContextRef.current)
    if (!requestContext) return
    setLoading(false)
    setSavingId(series.id)
    setError('')
    await runAccountOperation({
      gate: actionGate,
      requestContext,
      getCurrentContext: () => currentContextRef.current,
      operation: async () => action(
        series.id,
        await captureApiOperationContext(requestContext, 'pet'),
      ),
      onSuccess: (updated) => {
        setSeriesItems((current) => (
          updated.status === 'canceled'
            ? current.filter((item) => item.id !== series.id)
            : current.map((item) => (item.id === series.id ? updated : item))
        ))
        onUpdated?.(updated, requestContext)
      },
      onError: () => setError(copy.updateFailed),
      onFinally: () => setSavingId(null),
    })
    operationsRef.current.finishAction(requestContext)
  }

  const handleCancel = (series) => {
    if (!window.confirm(copy.confirmCancel(series.title))) {
      return
    }
    void updateSeries(series, cancelReminderSeries)
  }

  return (
    <section className="recurring-reminder-panel" aria-label={copy.title}>
      <div className="pending-reminder-header">
        <div className="sidebar-title recurring-reminder-heading">
          <Repeat2 size={14} aria-hidden="true" />
          <span>{copy.title}</span>
        </div>
        <button
          type="button"
          className="pending-reminder-icon-button"
          title={copy.refresh}
          aria-label={copy.refresh}
          disabled={loading || savingId !== null}
          onClick={() => {
            void loadSeries()
          }}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      {loading && <div className="pending-reminder-empty" role="status">{copy.loading}</div>}
      {error && <div className="pending-reminder-error" role="status">{error}</div>}
      {!loading && seriesItems.length === 0 && !error && (
        <div className="pending-reminder-empty">{copy.empty}</div>
      )}
      {seriesItems.length > 0 && (
        <div className="recurring-reminder-list">
          {seriesItems.map((series) => {
            const isPaused = series.status === 'paused'
            return (
              <div className="recurring-reminder-item" key={series.id} aria-busy={savingId === series.id}>
                <div className="pending-reminder-copy">
                  <div className="pending-reminder-title">{series.title}</div>
                  <div className="recurring-reminder-schedule">
                    {formatReminderSeriesSchedule(series, language, copy)}
                    <span className={isPaused ? 'is-paused' : 'is-active'}>
                      {isPaused ? copy.paused : copy.active}
                    </span>
                  </div>
                </div>
                <div className="pending-reminder-actions">
                  <button
                    type="button"
                    className="pending-reminder-retry"
                    title={isPaused ? copy.resume(series.title) : copy.pause(series.title)}
                    aria-label={isPaused ? copy.resume(series.title) : copy.pause(series.title)}
                    disabled={savingId !== null}
                    onClick={() => {
                      void updateSeries(
                        series,
                        isPaused ? resumeReminderSeries : pauseReminderSeries,
                      )
                    }}
                  >
                    {isPaused
                      ? <Play size={14} aria-hidden="true" />
                      : <Pause size={14} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="pending-reminder-complete"
                    title={copy.cancel(series.title)}
                    aria-label={copy.cancel(series.title)}
                    disabled={savingId !== null}
                    onClick={() => handleCancel(series)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
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
