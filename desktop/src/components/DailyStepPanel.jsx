import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BellPlus, Check, Play } from 'lucide-react'

import {
  DAILY_STEP_TITLE_LENGTH,
  getDailyStepDate,
  getDailyStepStorageKey,
  getDailyStepTitle,
  readCompletedDailySteps,
  readDailyStep,
  readDailyStepCarryOver,
  readTomorrowDailyStep,
  writeDailyStep,
  writeTomorrowDailyStep,
} from '../shared/daily-step'
import { getFocusHistoryRefreshDelay } from '../shared/focus-history'
import './daily-step.css'

const COPY = {
  'zh-CN': {
    title: '今天的一小步',
    prompt: '今天想做哪件小事？',
    placeholder: '比如，读几页书',
    save: '记下来',
    edit: '编辑',
    cancel: '取消',
    remove: '移除',
    focus: '陪我做',
    remind: '设提醒',
    complete: '做完了',
    completed: '已完成',
    undo: '撤销完成',
    yesterday: '昨天还没做完',
    carryOver: '今天继续',
    tomorrow: '明天的小步骤',
    tomorrowOpen: '安排明天',
    tomorrowPrompt: '明天想做哪件小事？',
    tomorrowEdit: '编辑明天计划',
    tomorrowSave: '保存明天计划',
    tomorrowRemove: '移除明天计划',
    history: (count) => `近 7 天完成了 ${count} 个小步骤`,
    local: '仅保存在这台设备，按本机日期更新。',
    error: '没能在这台设备上保存这次更改，请重试。',
  },
  en: {
    title: 'One small step today',
    prompt: 'What would you like to do today?',
    placeholder: 'Maybe read a few pages',
    save: 'Save step',
    edit: 'Edit',
    cancel: 'Cancel',
    remove: 'Remove',
    focus: 'Focus together',
    remind: 'Set reminder',
    complete: 'Done',
    completed: 'Completed',
    undo: 'Undo completion',
    yesterday: 'Unfinished yesterday',
    carryOver: 'Continue today',
    tomorrow: 'Tomorrow’s small step',
    tomorrowOpen: 'Plan tomorrow',
    tomorrowPrompt: 'What would you like to do tomorrow?',
    tomorrowEdit: 'Edit tomorrow’s plan',
    tomorrowSave: 'Save tomorrow’s plan',
    tomorrowRemove: 'Remove tomorrow’s plan',
    history: (count) => `Completed ${count} ${count === 1 ? 'small step' : 'small steps'} in the last 7 days`,
    local: 'Saved on this device using its local date.',
    error: 'This change could not be saved on this device. Please try again.',
  },
}

function TomorrowStep({ language, storageKey, date, isToday, canPlan, fallbackFocusRef }) {
  const copy = COPY[language]
  const [plan, setPlan] = useState(() => readTomorrowDailyStep(storageKey, date))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef(null)
  const openRef = useRef(null)
  const restoreFocusRef = useRef(false)
  const title = getDailyStepTitle(draft)

  useEffect(() => {
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    const target = editing ? inputRef.current : (openRef.current ?? fallbackFocusRef.current)
    target?.focus()
  }, [editing, plan, fallbackFocusRef])

  const open = () => {
    if (!isToday(date)) return
    restoreFocusRef.current = true
    setDraft(plan?.title ?? '')
    setError(false)
    setEditing(true)
  }

  const close = () => {
    restoreFocusRef.current = true
    setEditing(false)
    setDraft('')
    setError(false)
  }

  const apply = (nextTitle) => {
    if (!isToday(date)) return
    if (!writeTomorrowDailyStep(storageKey, date, nextTitle)) {
      setError(true)
      return
    }
    setPlan(readTomorrowDailyStep(storageKey, date))
    close()
  }

  if (editing) return (
    <form className="daily-step-tomorrow" data-e2e="daily-step-tomorrow-form" onSubmit={(event) => {
      event.preventDefault()
      if (title) apply(title)
    }}>
      <label className="daily-step-input">
        {copy.tomorrowPrompt}
        <input
          ref={inputRef}
          value={draft}
          maxLength={DAILY_STEP_TITLE_LENGTH}
          placeholder={copy.placeholder}
          data-e2e="daily-step-tomorrow-input"
          onChange={(event) => {
            setDraft(event.target.value)
            setError(false)
          }}
        />
      </label>
      <div className="daily-step-actions">
        <button type="submit" className="daily-step-primary" data-e2e="daily-step-tomorrow-save" disabled={!title}>{copy.tomorrowSave}</button>
        <button type="button" data-e2e="daily-step-tomorrow-cancel" onClick={close}>{copy.cancel}</button>
      </div>
      {error && <p className="daily-step-error" role="alert">{copy.error}</p>}
    </form>
  )

  if (!canPlan && !plan) return null
  return (
    <div className={plan ? 'daily-step-tomorrow' : undefined}>
      {plan && <>
        <div className="daily-step-tomorrow-label">
          <span>{copy.tomorrow}</span>
          <time dateTime={plan.date}>{new Date(`${plan.date}T00:00:00Z`).toLocaleDateString(language, { timeZone: 'UTC', month: 'short', day: 'numeric' })}</time>
        </div>
        <p className="daily-step-title" data-e2e="daily-step-tomorrow-title">{plan.title}</p>
      </>}
      <div className="daily-step-actions">
        <button ref={openRef} type="button" data-e2e="daily-step-tomorrow" onClick={open}>{plan ? copy.tomorrowEdit : copy.tomorrowOpen}</button>
        {plan && <button type="button" className="daily-step-remove" data-e2e="daily-step-tomorrow-remove" onClick={() => apply(null)}>{copy.tomorrowRemove}</button>}
      </div>
      {error && <p className="daily-step-error" role="alert">{copy.error}</p>}
    </div>
  )
}

function DailyStep({ language, storageKey, date, isToday, onFocus, onRemind }) {
  const copy = COPY[language]
  const [step, setStep] = useState(() => readDailyStep(storageKey, date))
  const [carryOver, setCarryOver] = useState(() => readDailyStepCarryOver(storageKey, date))
  const [history, setHistory] = useState(() => readCompletedDailySteps(storageKey, date))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const headingId = useId()
  const inputRef = useRef(null)
  const editRef = useRef(null)
  const statusActionRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const title = getDailyStepTitle(draft)
  const historyDateFormat = history.some((entry) => entry.date !== date)
    ? new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short', day: 'numeric' })
    : null

  useEffect(() => {
    restoreFocusRef.current?.current?.focus()
    restoreFocusRef.current = null
  }, [editing, step])

  const apply = (nextStep, nextFocus) => {
    if (!isToday(date)) return
    if (!writeDailyStep(storageKey, date, nextStep)) {
      setError(true)
      return
    }
    restoreFocusRef.current = nextFocus
    setError(false)
    setStep(nextStep)
    setCarryOver(null)
    setHistory(readCompletedDailySteps(storageKey, date))
    setEditing(false)
    setDraft('')
  }

  const edit = () => {
    if (!isToday(date)) return
    setDraft(step.title)
    setError(false)
    restoreFocusRef.current = inputRef
    setEditing(true)
  }

  const cancel = () => {
    restoreFocusRef.current = editRef
    setEditing(false)
    setError(false)
    setDraft('')
  }

  const continueYesterday = () => {
    if (step || draft || inputRef.current?.value || !isToday(date)) return
    const latest = readDailyStepCarryOver(storageKey, date)
    if (!latest || latest.title !== carryOver?.title) {
      setCarryOver(latest)
      return
    }
    apply(latest, editRef)
  }

  return (
    <section
      className="daily-step"
      aria-labelledby={headingId}
      data-e2e="daily-step"
      data-state={step ? (step.completed ? 'completed' : 'planned') : 'empty'}
    >
      <div className="daily-step-heading">
        <h3 id={headingId}>{copy.title}</h3>
        {step?.completed && <span className="daily-step-status" role="status"><Check size={13} aria-hidden="true" />{copy.completed}</span>}
      </div>
      {editing || !step ? (
        <form onSubmit={(event) => {
          event.preventDefault()
          if (title) apply({ title, completed: step?.completed ?? false }, editRef)
        }}>
          <label className="daily-step-input">
            {copy.prompt}
            <input
              ref={inputRef}
              value={draft}
              maxLength={DAILY_STEP_TITLE_LENGTH}
              placeholder={copy.placeholder}
              data-e2e="daily-step-input"
              onChange={(event) => {
                setDraft(event.target.value)
                setError(false)
              }}
            />
          </label>
          <div className="daily-step-actions">
            <button type="submit" className="daily-step-primary" data-e2e="daily-step-save" disabled={!title}>{copy.save}</button>
            {step && <>
              <button type="button" onClick={cancel}>{copy.cancel}</button>
              <button type="button" className="daily-step-remove" data-e2e="daily-step-remove" onClick={() => apply(null, inputRef)}>{copy.remove}</button>
            </>}
          </div>
        </form>
      ) : (
        <>
          <p className="daily-step-title" data-e2e="daily-step-title">{step.title}</p>
          <div className="daily-step-actions">
            {!step.completed && onFocus && <button type="button" className="daily-step-primary" data-e2e="daily-step-focus" onClick={() => {
              if (isToday(date)) onFocus(step.title)
            }}><Play size={12} aria-hidden="true" />{copy.focus}</button>}
            {!step.completed && onRemind && (
              <button type="button" data-e2e="daily-step-remind" onClick={() => {
                if (isToday(date)) onRemind(step.title)
              }}>
                <BellPlus size={12} aria-hidden="true" />{copy.remind}
              </button>
            )}
            <button
              ref={statusActionRef}
              type="button"
              data-e2e={step.completed ? 'daily-step-undo' : 'daily-step-complete'}
              onClick={() => apply({ ...step, completed: !step.completed }, statusActionRef)}
            >{step.completed ? copy.undo : copy.complete}</button>
            <button ref={editRef} type="button" data-e2e="daily-step-edit" onClick={edit}>{copy.edit}</button>
          </div>
        </>
      )}
      {!step && carryOver && (
        <div className="daily-step-carry-over">
          <div className="daily-step-carry-over-label">{copy.yesterday}</div>
          <p className="daily-step-title" data-e2e="daily-step-carry-over-title">{carryOver.title}</p>
          <div className="daily-step-actions">
            <button type="button" data-e2e="daily-step-carry-over" disabled={Boolean(draft)} onClick={continueYesterday}>
              {copy.carryOver}
            </button>
          </div>
        </div>
      )}
      <TomorrowStep
        language={language}
        storageKey={storageKey}
        date={date}
        isToday={isToday}
        canPlan={Boolean(step?.completed)}
        fallbackFocusRef={editing || !step ? inputRef : editRef}
      />
      {historyDateFormat && (
        <details className="daily-step-history" data-e2e="daily-step-history">
          <summary>{copy.history(history.length)}</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.date} data-e2e="daily-step-history-row">
                <time dateTime={entry.date}>{historyDateFormat.format(new Date(`${entry.date}T00:00:00Z`))}</time>
                <span>{entry.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="daily-step-local">{copy.local}</p>
      {error && <p className="daily-step-error" role="alert">{copy.error}</p>}
    </section>
  )
}

export function DailyStepPanel({ language, accountContext, onFocus, onRemind }) {
  const [date, setDate] = useState(getDailyStepDate)
  const storageKey = getDailyStepStorageKey(accountContext)

  const isToday = useCallback((expectedDate) => {
    const today = getDailyStepDate()
    setDate(today)
    return today === expectedDate
  }, [])

  useEffect(() => {
    let timer
    const refresh = () => {
      window.clearTimeout(timer)
      const now = Date.now()
      setDate(getDailyStepDate(now))
      timer = window.setTimeout(refresh, getFocusHistoryRefreshDelay(now))
    }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    const unsubscribeResume = window.desktopBridge?.onSystemResume?.(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    refresh()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribeResume?.()
    }
  }, [])

  if (!storageKey || !date) return null
  return <DailyStep
    key={`${storageKey}:${date}`}
    language={language === 'zh-CN' ? 'zh-CN' : 'en'}
    storageKey={storageKey}
    date={date}
    isToday={isToday}
    onFocus={onFocus}
    onRemind={onRemind}
  />
}
