import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { captureApiOperationContext } from '../shared/api'
import { getFocusHistoryRefreshDelay } from '../shared/focus-history'
import { createAccountOperationGate } from '../shared/pet-account-context'
import { getPendingReminders, getReminderSeries } from '../shared/reminders-api'
import { getTodayReminderAgenda } from '../shared/today-reminder-agenda'
import './today-reminder-agenda.css'

const VISIBLE_ITEMS = 3
const CLOCK_CHANGE_THRESHOLD_MS = 60_000
const REFRESH_INTERVAL_MS = 30_000
const COPY = {
  'zh-CN': {
    heading: '今日提醒',
    loading: '正在更新提醒…',
    empty: '今天没有待处理的提醒。',
    error: '部分提醒暂时无法读取。',
    retry: '重试',
    earlier: (count) => `之前还有 ${count} 项未完成`,
    more: (count) => `还有 ${count} 项`,
    delivered: '已提醒',
    deliveredToday: '今日送达',
    due: '已到期',
    scheduled: '待提醒',
    projected: '周期计划',
  },
  en: {
    heading: 'Today’s reminders',
    loading: 'Updating reminders…',
    empty: 'Nothing left to remind you about today.',
    error: 'Some reminders could not load.',
    retry: 'Retry',
    earlier: (count) => `${count} unfinished from earlier`,
    more: (count) => `${count} more today`,
    delivered: 'Delivered',
    deliveredToday: 'Delivered today',
    due: 'Due',
    scheduled: 'Scheduled',
    projected: 'Recurring plan',
  },
}

function readDeviceClock() {
  const now = Date.now()
  const date = new Date(now)
  return { now, monotonic: performance.now(), day: date.toDateString(), offset: date.getTimezoneOffset() }
}

function useAgendaClock(onRefresh) {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    let previous = readDeviceClock()
    let timer
    const read = (refresh = false) => {
      const current = readDeviceClock()
      const clockShift = (current.now - previous.now) - (current.monotonic - previous.monotonic)
      const calendarChanged = current.day !== previous.day || current.offset !== previous.offset
      previous = current
      setNow(current.now)
      window.clearTimeout(timer)
      timer = window.setTimeout(read, getFocusHistoryRefreshDelay(current.now))
      if (refresh || calendarChanged || Math.abs(clockShift) > CLOCK_CHANGE_THRESHOLD_MS) onRefresh?.()
    }
    const onFocus = () => read()
    const onVisibility = () => { if (document.visibilityState === 'visible') read() }
    const unsubscribeResume = window.desktopBridge?.onSystemResume?.(() => read(true))
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    read()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribeResume?.()
    }
  }, [onRefresh])

  return [now, setNow]
}

function useAgendaSnapshot(accountContext) {
  const [snapshot, setSnapshot] = useState({ day: null, status: 'loading', reminders: [], series: [] })
  const contextRef = useRef(accountContext)
  const refreshRef = useRef(null)
  contextRef.current = accountContext
  const refresh = useCallback(() => refreshRef.current?.(), [])
  const petType = accountContext.petType

  useEffect(() => {
    const gate = createAccountOperationGate()
    let active = true
    let inFlight = false
    let scheduled = false
    let queued = false

    const load = async () => {
      inFlight = true
      const request = gate.begin(contextRef.current)
      const isCurrent = () => active && gate.isCurrent(request, contextRef.current)
      const end = new Date(Date.now())
      const day = end.toDateString()
      end.setHours(24, 0, 0, 0)
      try {
        const operation = await captureApiOperationContext(request, 'pet')
        if (!isCurrent()) return
        // Materialization advances the series and inserts the reminder together.
        // Read instances second so a materialized reminder replaces its projection in the same render.
        const series = await getReminderSeries(petType, operation).catch(() => null)
        if (!isCurrent()) return
        const reminders = await getPendingReminders(petType, end, null, operation)
        if (!Array.isArray(reminders)) throw new Error('invalid_reminder_list')
        if (isCurrent()) setSnapshot((current) => ({
          day, reminders, status: Array.isArray(series) ? 'ready' : 'error',
          series: Array.isArray(series) ? series : current.day === day ? current.series : [],
        }))
      } catch {
        if (isCurrent()) setSnapshot((current) => ({ ...current, status: 'error' }))
      } finally {
        inFlight = false
        if (queued) {
          queued = false
          requestRefresh()
        }
      }
    }

    function requestRefresh() {
      if (!active || scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (!active) return
        if (inFlight) {
          queued = true
        } else {
          void load()
        }
      })
    }

    const refreshIfVisible = () => { if (document.visibilityState === 'visible') requestRefresh() }
    refreshRef.current = requestRefresh
    requestRefresh()
    const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS)
    window.addEventListener('detachym:reminders-changed', requestRefresh)
    window.addEventListener('detachym:reminder-series-changed', requestRefresh)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      active = false
      gate.invalidate()
      refreshRef.current = null
      window.clearInterval(timer)
      window.removeEventListener('detachym:reminders-changed', requestRefresh)
      window.removeEventListener('detachym:reminder-series-changed', requestRefresh)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [petType])

  return { snapshot, refresh }
}

export function TodayReminderAgenda({ language, accountContext, onNavigate }) {
  const headingId = useId()
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const copy = COPY[locale]
  const { snapshot, refresh } = useAgendaSnapshot(accountContext)
  const [now, setNow] = useAgendaClock(refresh)
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
  const dayIsCurrent = snapshot.day === new Date(now).toDateString()
  const { items, earlierUnfinished, earlierDestination } = getTodayReminderAgenda({
    scheduled: dayIsCurrent ? snapshot.reminders : [],
    series: dayIsCurrent ? snapshot.series : [],
    accountContext, now,
  })
  const state = snapshot.status === 'error' ? 'error'
    : !dayIsCurrent || snapshot.status === 'loading' ? 'loading'
      : items.length ? 'ready' : 'empty'
  const firstHidden = items[VISIBLE_ITEMS]

  return (
    <section className="today-reminder-agenda" aria-labelledby={headingId} aria-busy={state === 'loading'}
      data-e2e="today-reminder-agenda" data-state={state}>
      <h3 id={headingId}>{copy.heading}</h3>
      {items.length > 0 && (
        <ul className="today-agenda-list">
          {items.slice(0, VISIBLE_ITEMS).map((item) => {
            const time = item.lateDeliveryAt ?? item.remindAt
            return (
              <li key={item.key}>
                <button type="button" className="today-agenda-item" data-e2e="today-agenda-item"
                  data-status={item.status} data-destination={item.destination} data-target-id={item.targetId}
                  onClick={() => onNavigate(item.destination, item.targetId)}>
                  <time dateTime={new Date(time).toISOString()}>{timeFormat.format(time)}</time>
                  <span className="today-agenda-item-copy">
                    <span className="today-agenda-item-title">{item.title}</span>
                    <span className="today-agenda-item-status">{item.lateDeliveryAt === undefined ? copy[item.status] : copy.deliveredToday}</span>
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {state !== 'ready' && <p className="today-agenda-status" role="status">{copy[state]}</p>}
      {firstHidden && (
        <button type="button" className="today-agenda-link" data-e2e="today-agenda-more"
          onClick={() => onNavigate(firstHidden.destination)}>{copy.more(items.length - VISIBLE_ITEMS)}</button>
      )}
      {earlierUnfinished > 0 && (
        <button type="button" className="today-agenda-link" data-e2e="today-agenda-earlier"
          onClick={() => onNavigate(earlierDestination || 'delivered')}>{copy.earlier(earlierUnfinished)}</button>
      )}
      {state === 'error' && (
        <button type="button" className="today-agenda-link" data-e2e="today-agenda-retry"
          onClick={() => { setNow(Date.now()); refresh() }}>{copy.retry}</button>
      )}
    </section>
  )
}
