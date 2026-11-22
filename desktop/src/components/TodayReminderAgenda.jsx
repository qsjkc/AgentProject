import { useEffect, useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { getFocusHistoryRefreshDelay } from '../shared/focus-history'
import { getTodayReminderAgenda } from '../shared/today-reminder-agenda'
import './today-reminder-agenda.css'

const VISIBLE_ITEMS = 3
const CLOCK_CHANGE_THRESHOLD_MS = 60_000
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

function readyRows(source) {
  return source?.status === 'ready' ? source.rows : undefined
}

export function TodayReminderAgenda({ language, sources, accountContext, onNavigate, onRefresh }) {
  const headingId = useId()
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const copy = COPY[locale]
  const [now, setNow] = useAgendaClock(onRefresh)
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
  const delivered = sources?.delivered
  const scheduled = sources?.scheduled
  const series = sources?.series
  const { items, earlierUnfinished, earlierDestination } = getTodayReminderAgenda({
    delivered: readyRows(delivered), scheduled: readyRows(scheduled), series: readyRows(series), accountContext, now,
  })
  const statuses = [delivered, scheduled, series].map((source) => source?.status ?? 'loading')
  const state = statuses.includes('error') ? 'error'
    : statuses.includes('loading') ? 'loading'
      : items.length ? 'ready' : 'empty'
  const firstHidden = items[VISIBLE_ITEMS]

  return (
    <section className="today-reminder-agenda" aria-labelledby={headingId} aria-busy={state === 'loading'}
      data-e2e="today-reminder-agenda" data-state={state}>
      <h3 id={headingId}>{copy.heading}</h3>
      {items.length > 0 && (
        <ul className="today-agenda-list">
          {items.slice(0, VISIBLE_ITEMS).map((item) => (
            <li key={item.key}>
              <button type="button" className="today-agenda-item" data-e2e="today-agenda-item"
                data-status={item.status} data-destination={item.destination} onClick={() => onNavigate(item.destination)}>
                <time dateTime={new Date(item.remindAt).toISOString()}>{timeFormat.format(item.remindAt)}</time>
                <span className="today-agenda-item-copy">
                  <span className="today-agenda-item-title">{item.title}</span>
                  <span className="today-agenda-item-status">{copy[item.status]}</span>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
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
      {state === 'error' && onRefresh && (
        <button type="button" className="today-agenda-link" data-e2e="today-agenda-retry"
          onClick={() => { setNow(Date.now()); onRefresh() }}>{copy.retry}</button>
      )}
    </section>
  )
}
