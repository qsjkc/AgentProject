import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, RefreshCw, Trash2 } from 'lucide-react'

import { captureApiOperationContext, desktopApiRequest } from '../shared/api'
import { commitAccountOperation } from '../shared/pet-account-context'
import { createReminderPanelOperations } from '../shared/reminder-panel-operations'
import { getPendingReminders, skipReminderOccurrence } from '../shared/reminders-api'
import { getUpcomingOneTimeReminders, parseReminderReschedule, toReminderLocalInput } from '../shared/upcoming-reminders'

const REFRESH_INTERVAL_MS = 30000

function getCopy(language) {
  return language === 'zh-CN' ? {
    title: '待提醒',
    hint: '还没提醒的一次性事项，可以在这里改时间或取消。',
    empty: '还没有待提醒的一次性事项。',
    loading: '正在查看待提醒事项…',
    refresh: '刷新待提醒事项',
    edit: (title) => `修改提醒时间：${title}`,
    cancel: (title) => `取消提醒：${title}`,
    timeLabel: '新的提醒时间（设备本地时间）',
    save: '保存时间',
    discard: '放弃修改',
    invalidTime: '请选择有效的本地日期和时间。',
    pastTime: '请选择未来的时间。',
    loadFailed: '待提醒事项加载失败，请刷新重试。',
    saveFailed: '时间没有保存成功，请检查网络后重试。',
    cancelFailed: '提醒没有取消成功，请稍后重试。',
    canceled: (title) => `已取消“${title}”。`,
    saved: (title, time) => `“${title}”已改为 ${time} 提醒。`,
    changed: '这条提醒的状态已更新，请查看最新列表或待处理提醒。',
  } : {
    title: 'Upcoming reminders',
    hint: 'Change the time or cancel a one-time reminder before it is delivered.',
    empty: 'No one-time reminders are waiting to be delivered.',
    loading: 'Checking upcoming reminders…',
    refresh: 'Refresh upcoming reminders',
    edit: (title) => `Change reminder time: ${title}`,
    cancel: (title) => `Cancel reminder: ${title}`,
    timeLabel: 'New reminder time (this device’s local time)',
    save: 'Save time',
    discard: 'Discard changes',
    invalidTime: 'Choose a valid local date and time.',
    pastTime: 'Choose a time in the future.',
    loadFailed: 'Could not load upcoming reminders. Refresh to try again.',
    saveFailed: 'The time was not saved. Check your connection and try again.',
    cancelFailed: 'The reminder was not canceled. Try again.',
    canceled: (title) => `Canceled “${title}”.`,
    saved: (title, time) => `“${title}” will now remind you at ${time}.`,
    changed: 'This reminder has changed. Check the latest list or delivered reminders.',
  }
}

function formatTime(value, language) {
  return new Date(value).toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function actionErrorMessage(error, fallback) {
  return [400, 409, 422].includes(error?.status) && typeof error.message === 'string'
    ? error.message
    : fallback
}

export function UpcomingReminderPanel(props) {
  const { accountContext, petType } = props
  const identity = JSON.stringify([
    accountContext?.server, accountContext?.userId, petType,
    accountContext?.session?.generation, accountContext?.epoch,
  ])
  return <UpcomingReminderList key={identity} {...props} />
}

function UpcomingReminderList({ language, petType, accountContext }) {
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [editing, setEditing] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [editError, setEditError] = useState('')
  const [feedback, setFeedback] = useState('')
  const contextRef = useRef(accountContext)
  const editingRef = useRef(editing)
  const inputRef = useRef(null)
  const mountedRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  const loadRef = useRef(null)
  const operationsRef = useRef(null)
  if (!operationsRef.current) operationsRef.current = createReminderPanelOperations()
  const { loadGate, actionGate } = operationsRef.current
  contextRef.current = accountContext
  editingRef.current = editing
  const copy = getCopy(language)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      queuedRefreshRef.current = false
      operationsRef.current.invalidate()
    }
  }, [])

  const loadReminders = useCallback(async ({ silent = false } = {}) => {
    const request = operationsRef.current.beginLoad(contextRef.current)
    if (!request) {
      queuedRefreshRef.current = true
      return
    }
    queuedRefreshRef.current = false
    if (!silent) setLoading(true)
    try {
      const operationContext = await captureApiOperationContext(request, 'pet')
      if (!loadGate.isCurrent(request, contextRef.current)) return
      const items = await getPendingReminders(petType, null, false, operationContext)
      commitAccountOperation(loadGate, request, contextRef.current, () => {
        const upcoming = getUpcomingOneTimeReminders(items, { userId: request.userId, petType })
        setReminders(upcoming)
        setLoadError('')
        if (editingRef.current && !upcoming.some((item) => item.id === editingRef.current.id)) {
          setEditing(null)
          setEditError('')
          setFeedback(copy.changed)
        }
      })
    } catch {
      commitAccountOperation(loadGate, request, contextRef.current, () => setLoadError(copy.loadFailed))
    } finally {
      commitAccountOperation(loadGate, request, contextRef.current, () => setLoading(false))
      operationsRef.current.finishLoad(request)
      if (mountedRef.current && queuedRefreshRef.current) {
        queuedRefreshRef.current = false
        void loadRef.current({ silent: true })
      }
    }
  }, [copy.changed, copy.loadFailed, loadGate, petType])
  loadRef.current = loadReminders

  useEffect(() => {
    void loadReminders()
    const refresh = () => { void loadReminders({ silent: true }) }
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refresh)
    window.addEventListener('detachym:reminders-changed', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('detachym:reminders-changed', refresh)
    }
  }, [loadReminders])

  useEffect(() => {
    if (editing?.id) inputRef.current?.focus()
  }, [editing?.id])

  const updateReminder = async (reminder, action) => {
    if (busy) return
    let remindAt = null
    if (action === 'reschedule') {
      if (editing?.id !== reminder.id) return
      const parsed = parseReminderReschedule(editing.value, reminder.remind_at)
      if (!parsed.ok) {
        setEditError(parsed.reason === 'past_time' ? copy.pastTime : copy.invalidTime)
        inputRef.current?.focus()
        return
      }
      remindAt = parsed.remindAt
    }
    const request = operationsRef.current.beginAction(contextRef.current)
    if (!request) return
    setBusy({ id: reminder.id, action })
    setLoading(false)
    setActionError('')
    setEditError('')
    setFeedback('')
    let committed = false
    let operationContext
    try {
      operationContext = await captureApiOperationContext(request, 'pet')
      if (!actionGate.isCurrent(request, contextRef.current)) return
      if (action === 'reschedule' && Date.parse(remindAt) <= Date.now()) {
        commitAccountOperation(actionGate, request, contextRef.current, () => setEditError(copy.pastTime))
        return
      }
      const updated = action === 'cancel'
        ? await skipReminderOccurrence(reminder.id, operationContext)
        : await desktopApiRequest(`/reminders/${reminder.id}`, {
          method: 'PATCH', body: JSON.stringify({ remind_at: remindAt }),
        }, operationContext)
      committed = commitAccountOperation(actionGate, request, contextRef.current, () => {
        const updatedRows = getUpcomingOneTimeReminders([updated], { userId: request.userId, petType })
        setReminders((current) => getUpcomingOneTimeReminders([
          ...current.filter((item) => item.id !== reminder.id), ...updatedRows,
        ], { userId: request.userId, petType }))
        if (editingRef.current?.id === reminder.id) setEditing(null)
        setFeedback(action === 'cancel'
          ? copy.canceled(reminder.title)
          : updatedRows.length ? copy.saved(reminder.title, formatTime(updated.remind_at, language)) : copy.changed)
      })
    } catch (error) {
      commitAccountOperation(actionGate, request, contextRef.current, () => {
        if (action === 'reschedule') setEditError(actionErrorMessage(error, copy.saveFailed))
        else setActionError(actionErrorMessage(error, copy.cancelFailed))
      })
    } finally {
      commitAccountOperation(actionGate, request, contextRef.current, () => setBusy(null))
      operationsRef.current.finishAction(request)
      if (!committed && mountedRef.current && queuedRefreshRef.current) {
        queuedRefreshRef.current = false
        void loadRef.current({ silent: true })
      }
    }
    if (committed && actionGate.isCurrent(request, contextRef.current)) {
      window.dispatchEvent(new Event('detachym:reminders-changed'))
      // Reconcile the pet's deadline without replaying the creation animation.
      void window.desktopBridge?.notifyPetReminderEvent?.({
        type: 'updated', petType, reminderId: reminder.id,
      }, operationContext)?.catch(() => undefined)
    }
  }

  return (
    <section className="pending-reminder-panel" aria-label={copy.title} data-e2e="upcoming-reminders">
      <div className="pending-reminder-header">
        <div className="sidebar-title">{copy.title}</div>
        <button type="button" className="pending-reminder-icon-button" data-e2e="upcoming-reminder-refresh"
          aria-label={copy.refresh} title={copy.refresh} disabled={loading || Boolean(busy)}
          onClick={() => { void loadReminders() }}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-copy">{copy.hint}</div>
      {loading && <div className="pending-reminder-empty" role="status">{copy.loading}</div>}
      {(loadError || actionError) && <div className="pending-reminder-error" role="alert" data-e2e="upcoming-reminder-error">{actionError || loadError}</div>}
      {feedback && <div className="pending-reminder-empty" role="status" data-e2e="upcoming-reminder-feedback">{feedback}</div>}
      {!loading && !loadError && reminders.length === 0 && <div className="pending-reminder-empty" data-e2e="upcoming-reminder-empty">{copy.empty}</div>}
      {reminders.length > 0 && <div className="pending-reminder-list">
        {reminders.map((reminder) => (
          <div className="pending-reminder-item" key={reminder.id} data-e2e-upcoming-reminder-id={String(reminder.id)}
            role="group" aria-label={reminder.title} aria-busy={busy?.id === reminder.id}>
            <div className="pending-reminder-copy">
              <div className="pending-reminder-title">{reminder.title}</div>
              <div className="pending-reminder-time"><time dateTime={reminder.remind_at}>{formatTime(reminder.remind_at, language)}</time></div>
            </div>
            <div className="pending-reminder-actions">
              <button type="button" className="pending-reminder-retry" data-e2e-reminder-edit={String(reminder.id)}
                title={copy.edit(reminder.title)} aria-label={copy.edit(reminder.title)} disabled={Boolean(busy) || editing?.id === reminder.id}
                onClick={() => {
                  setEditing({ id: reminder.id, value: toReminderLocalInput(reminder.remind_at) })
                  setEditError('')
                  setActionError('')
                  setFeedback('')
                }}>
                <CalendarClock size={15} aria-hidden="true" />
              </button>
              <button type="button" className="pending-reminder-retry" data-e2e-reminder-cancel={String(reminder.id)}
                title={copy.cancel(reminder.title)} aria-label={copy.cancel(reminder.title)} disabled={Boolean(busy)}
                onClick={() => { void updateReminder(reminder, 'cancel') }}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
            {editing?.id === reminder.id && <form style={{ gridColumn: '1 / -1', minWidth: 0, paddingBottom: 10 }}
              onSubmit={(event) => { event.preventDefault(); void updateReminder(reminder, 'reschedule') }} noValidate>
              <label className="pending-reminder-time" htmlFor={`upcoming-reminder-time-${reminder.id}`}>{copy.timeLabel}</label>
              <input className="input" style={{ minWidth: 0, boxSizing: 'border-box', padding: '8px 6px', fontSize: 12 }}
                id={`upcoming-reminder-time-${reminder.id}`} ref={inputRef} type="datetime-local" step="60" required
                data-e2e-reminder-time={String(reminder.id)} value={editing.value} disabled={Boolean(busy)}
                aria-invalid={Boolean(editError)} aria-describedby={editError ? `upcoming-reminder-edit-error-${reminder.id}` : undefined}
                onChange={(event) => { setEditing({ id: reminder.id, value: event.target.value }); setEditError('') }} />
              {editError && <div className="pending-reminder-error" id={`upcoming-reminder-edit-error-${reminder.id}`} role="alert" data-e2e="upcoming-reminder-edit-error">{editError}</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                <button type="submit" className="button-secondary" style={{ padding: '6px 10px', fontSize: 11 }}
                  data-e2e-reminder-save-edit={String(reminder.id)} disabled={Boolean(busy)}>{copy.save}</button>
                <button type="button" className="button-secondary" style={{ padding: '6px 10px', fontSize: 11 }}
                  data-e2e-reminder-discard-edit={String(reminder.id)} disabled={Boolean(busy)}
                  onClick={() => { setEditing(null); setEditError('') }}>{copy.discard}</button>
              </div>
            </form>}
          </div>
        ))}
      </div>}
    </section>
  )
}
