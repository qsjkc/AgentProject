import { Play, Timer } from 'lucide-react'

import './today-focus-handoff.css'

export function TodayFocusHandoff({ state, remainingTime, busy, language, onAction }) {
  if (state?.status !== 'running' && state?.status !== 'paused') return null

  const zh = language === 'zh-CN'
  const paused = state.status === 'paused'
  const label = paused
    ? (zh ? '专注已暂停' : 'Focus paused')
    : (zh ? '正在专注' : 'Focus in progress')

  return (
    <div className="today-focus-handoff" data-e2e="today-focus-active" data-focus-status={state.status} aria-busy={busy}>
      <div className="today-focus-description" role="status">
        <strong><Timer size={14} aria-hidden="true" />{label}</strong>
        {state.intention && <span>{state.intention}</span>}
      </div>
      <div className="today-focus-actions">
        <span className="today-focus-time" role="timer" aria-live="off" aria-label={zh ? '剩余时间' : 'Time remaining'} data-e2e="today-focus-time">
          {remainingTime}
        </span>
        <button
          type="button"
          data-e2e="today-focus-action"
          aria-controls="companion-focus"
          disabled={busy}
          onClick={onAction}
        >
          {paused && <Play size={12} aria-hidden="true" />}
          {paused ? (zh ? '继续专注' : 'Continue') : (zh ? '查看计时' : 'Jump to timer')}
        </button>
      </div>
    </div>
  )
}
