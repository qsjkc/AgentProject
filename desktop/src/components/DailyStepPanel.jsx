import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, Play } from 'lucide-react'

import {
  DAILY_STEP_TITLE_LENGTH,
  getDailyStepDate,
  getDailyStepStorageKey,
  getDailyStepTitle,
  readDailyStep,
  writeDailyStep,
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
    complete: '做完了',
    completed: '已完成',
    undo: '撤销完成',
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
    complete: 'Done',
    completed: 'Completed',
    undo: 'Undo completion',
    local: 'Saved on this device. A new day starts with a blank step.',
    error: 'This change could not be saved on this device. Please try again.',
  },
}

function DailyStep({ copy, storageKey, date, isToday, onFocus }) {
  const [step, setStep] = useState(() => readDailyStep(storageKey, date))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const headingId = useId()
  const inputRef = useRef(null)
  const editRef = useRef(null)
  const statusActionRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const title = getDailyStepTitle(draft)

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
      <p className="daily-step-local">{copy.local}</p>
      {error && <p className="daily-step-error" role="alert">{copy.error}</p>}
    </section>
  )
}

export function DailyStepPanel({ language, accountContext, onFocus }) {
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
    copy={COPY[language] || COPY.en}
    storageKey={storageKey}
    date={date}
    isToday={isToday}
    onFocus={onFocus}
  />
}
