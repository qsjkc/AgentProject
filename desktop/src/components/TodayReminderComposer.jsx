import { useEffect, useId, useRef, useState } from 'react'
import { BellPlus } from 'lucide-react'

import { parseTodayReminderDraft, TODAY_REMINDER_PRESETS, TODAY_REMINDER_TITLE_LIMIT } from '../shared/today-reminder'
import { toReminderLocalInput } from '../shared/upcoming-reminders'
import './today-reminder.css'

const EMPTY_DRAFT = { title: '', minutes: 15, localTime: '' }

const COPY = {
  'zh-CN': {
    add: '添加提醒',
    title: '提醒事项',
    placeholder: '比如，给植物浇水',
    when: '什么时候提醒？',
    preset: (minutes) => minutes === 60 ? '1 小时后' : `${minutes} 分钟后`,
    custom: '自选时间',
    localTime: '日期和时间（本机时间）',
    save: '保存提醒',
    saving: '正在保存…',
    cancel: '取消',
    saved: '提醒已保存',
    invalid_title: '请输入 1 到 200 个字的提醒事项。',
    invalid_time: '请选择有效的本机日期和时间。',
    past_time: '请选择晚于现在的提醒时间。',
    save_failed: '提醒没有保存。请检查连接后重试。',
    save_unconfirmed: '暂时无法确认是否保存。请先查看待提醒事项。',
  },
  en: {
    add: 'Add reminder',
    title: 'Reminder',
    placeholder: 'For example, water the plants',
    when: 'When should I remind you?',
    preset: (minutes) => minutes === 60 ? 'In 1 hour' : `In ${minutes} min`,
    custom: 'Custom time',
    localTime: 'Date and time (device time)',
    save: 'Save reminder',
    saving: 'Saving…',
    cancel: 'Cancel',
    saved: 'Reminder saved',
    invalid_title: 'Enter a reminder between 1 and 200 characters.',
    invalid_time: 'Choose a valid date and time on this device.',
    past_time: 'Choose a future reminder time.',
    save_failed: 'The reminder could not be saved. Check your connection and try again.',
    save_unconfirmed: 'Could not confirm the save. Check upcoming reminders before trying again.',
  },
}

export function TodayReminderComposer({ language, canSave, onCreate, prefill, onPrefillHandled }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)
  const formId = useId()
  const errorId = `${formId}-error`
  const toggleRef = useRef(null)
  const savedRef = useRef(null)
  const titleRef = useRef(null)
  const localTimeRef = useRef(null)
  const submittingRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const handledPrefillRef = useRef(null)
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const copy = COPY[locale]
  const isCustom = draft.minutes === null
  const titleError = error === 'invalid_title'
  const timeError = error === 'invalid_time' || error === 'past_time'

  useEffect(() => {
    if (open) {
      titleRef.current?.focus()
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false
      const target = toggleRef.current?.disabled ? savedRef.current : toggleRef.current
      target?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!prefill || handledPrefillRef.current === prefill) return
    handledPrefillRef.current = prefill
    if (canSave && !submittingRef.current && typeof prefill.title === 'string' && prefill.title) {
      if (!titleRef.current?.value) {
        setDraft((current) => current.title ? current : { ...current, title: prefill.title })
      }
      setSaved(null)
      setOpen(true)
      titleRef.current?.focus()
    }
    onPrefillHandled?.(prefill)
  }, [canSave, onPrefillHandled, prefill])

  const updateDraft = (changes) => {
    setDraft((current) => ({ ...current, ...changes }))
    setError('')
  }

  const close = () => {
    restoreFocusRef.current = true
    setDraft(EMPTY_DRAFT)
    setError('')
    setOpen(false)
  }

  const submit = async (event) => {
    event.preventDefault()
    if (!canSave || submittingRef.current) return
    const request = parseTodayReminderDraft(draft)
    if (!request.ok) {
      setError(request.reason)
      const field = request.reason === 'invalid_title' ? titleRef : localTimeRef
      field.current?.focus()
      return
    }

    submittingRef.current = true
    setBusy(true)
    setError('')
    try {
      const row = await onCreate({ title: request.title, remindAt: request.remindAt })
      if (!row) return
      const remindAt = Number.isFinite(Date.parse(row.remind_at)) ? row.remind_at : request.remindAt
      setSaved({ title: row.title || request.title, remindAt })
      close()
    } catch (failure) {
      const reason = failure?.message === 'past_time' ? 'past_time'
        : failure?.code === 'REQUEST_TIMEOUT' || failure instanceof TypeError ? 'save_unconfirmed'
          : 'save_failed'
      setError(reason)
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="today-reminder">
      {!open && (
        <button
          ref={toggleRef}
          type="button"
          data-e2e="today-reminder-toggle"
          aria-expanded={false}
          aria-controls={formId}
          disabled={!canSave}
          onClick={() => {
            setSaved(null)
            setOpen(true)
          }}
        >
          <BellPlus size={14} aria-hidden="true" />{copy.add}
        </button>
      )}
      <div id={formId} hidden={!open}>
        {open && (
          <form className="today-reminder-form" data-e2e="today-reminder-form" aria-label={copy.add} aria-busy={busy} onSubmit={submit} noValidate>
            <label className="today-reminder-field">
              {copy.title}
              <input
                ref={titleRef}
                type="text"
                data-e2e="today-reminder-title"
                value={draft.title}
                placeholder={copy.placeholder}
                maxLength={TODAY_REMINDER_TITLE_LIMIT}
                required
                disabled={busy}
                aria-invalid={titleError}
                aria-describedby={titleError ? errorId : undefined}
                onChange={(event) => updateDraft({ title: event.target.value })}
              />
            </label>
            <fieldset className="today-reminder-options" disabled={busy}>
              <legend>{copy.when}</legend>
              {[...TODAY_REMINDER_PRESETS, null].map((minutes) => (
                <label key={minutes ?? 'custom'}>
                  <input
                    type="radio"
                    name={`${formId}-delay`}
                    data-e2e={`today-reminder-delay-${minutes ?? 'custom'}`}
                    checked={draft.minutes === minutes}
                    onChange={() => updateDraft({ minutes })}
                  />
                  {minutes === null ? copy.custom : copy.preset(minutes)}
                </label>
              ))}
            </fieldset>
            {isCustom && (
              <label className="today-reminder-field">
                {copy.localTime}
                <input
                  ref={localTimeRef}
                  type="datetime-local"
                  data-e2e="today-reminder-custom-time"
                  step="60"
                  min={toReminderLocalInput((Math.floor(Date.now() / 60_000) + 1) * 60_000)}
                  value={draft.localTime}
                  required
                  disabled={busy}
                  aria-invalid={timeError}
                  aria-describedby={timeError ? errorId : undefined}
                  onChange={(event) => updateDraft({ localTime: event.target.value })}
                />
              </label>
            )}
            {error && <p id={errorId} className="today-reminder-error" data-e2e="today-reminder-error" role="alert">{copy[error]}</p>}
            <div className="today-reminder-actions">
              <button type="submit" className="today-reminder-save" data-e2e="today-reminder-save"
                disabled={!canSave || busy || !draft.title.trim() || (isCustom && !draft.localTime)}>
                {busy ? copy.saving : copy.save}
              </button>
              <button type="button" data-e2e="today-reminder-cancel" disabled={busy} onClick={close}>{copy.cancel}</button>
            </div>
          </form>
        )}
      </div>
      {saved && (
        <p ref={savedRef} tabIndex={-1} className="today-reminder-success" role="status" data-e2e="today-reminder-success">
          <strong>{copy.saved}</strong>
          <span>{saved.title} · <time dateTime={saved.remindAt}>
            {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(saved.remindAt))}
          </time></span>
        </p>
      )}
    </div>
  )
}
