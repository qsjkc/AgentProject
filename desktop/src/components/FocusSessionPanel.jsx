import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Pause, Play, RefreshCw, Sprout } from 'lucide-react'

import { captureApiOperationContext } from '../shared/api'
import { captureFocusSnapshot, formatFocusTime, getFocusSnapshotRemainingMs, isFocusSnapshotCurrent } from '../shared/focus-session'
import './focus-session.css'

export function FocusSessionPanel({ language, accountContext }) {
  const zh = language === 'zh-CN'
  const languageRef = useRef(zh)
  languageRef.current = zh
  const [snapshot, setSnapshot] = useState(null)
  const [minutes, setMinutes] = useState(25)
  const [intention, setIntention] = useState('')
  const [now, setNow] = useState(() => performance.now())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const contextRef = useRef(accountContext)
  const snapshotRef = useRef(null)
  const mutationRef = useRef(false)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  contextRef.current = accountContext
  const contextKey = JSON.stringify([accountContext?.server, accountContext?.userId, accountContext?.petType, accountContext?.session?.generation, accountContext?.epoch])
  const keyRef = useRef(contextKey)
  keyRef.current = contextKey

  const applySnapshot = useCallback((value) => {
    if (!mountedRef.current || !isFocusSnapshotCurrent(value, contextRef.current)) return false
    const previous = snapshotRef.current
    if (isFocusSnapshotCurrent(previous, contextRef.current) && previous?.state?.revision > value?.state?.revision) return true
    const receivedAt = performance.now()
    const captured = captureFocusSnapshot(value, previous, receivedAt)
    snapshotRef.current = captured
    setSnapshot(captured)
    setError('')
    setNow(receivedAt)
    return true
  }, [])

  const load = useCallback(async () => {
    const request = ++requestRef.current
    const requestKey = keyRef.current
    setLoading(true)
    try {
      const operation = await captureApiOperationContext(contextRef.current, 'pet')
      if (!mountedRef.current || requestKey !== keyRef.current) return
      const result = await window.desktopBridge?.getFocusSession?.(operation)
      if (!mountedRef.current || request !== requestRef.current || requestKey !== keyRef.current) return
      if (!result?.ok || !applySnapshot(result)) throw new Error('focus_unavailable')
      setError('')
    } catch {
      if (mountedRef.current && request === requestRef.current && requestKey === keyRef.current) {
        setError(languageRef.current ? '暂时无法读取专注状态，请重试。' : 'Focus is unavailable for a moment. Please retry.')
      }
    } finally {
      if (mountedRef.current && request === requestRef.current && requestKey === keyRef.current) setLoading(false)
    }
  }, [applySnapshot])

  useEffect(() => {
    mountedRef.current = true
    snapshotRef.current = null
    setSnapshot(null)
    setIntention('')
    setError('')
    mutationRef.current = false
    setBusy(false)
    const unsubscribe = window.desktopBridge?.onFocusSessionChanged?.(applySnapshot)
    void load()
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      unsubscribe?.()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [applySnapshot, contextKey, load])

  const state = isFocusSnapshotCurrent(snapshot, accountContext) ? snapshot.state : null
  const status = state?.status || 'idle'
  useEffect(() => {
    if (status !== 'running') return undefined
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [status])

  async function act(command) {
    if (mutationRef.current || !state) return
    mutationRef.current = true
    const requestKey = keyRef.current
    setBusy(true)
    setError('')
    try {
      const operation = await captureApiOperationContext(contextRef.current, 'pet')
      if (!mountedRef.current || requestKey !== keyRef.current) return
      const result = await window.desktopBridge?.updateFocusSession?.(command, {
        expectedRevision: state.revision, minutes, intention,
      }, operation)
      if (!mountedRef.current || requestKey !== keyRef.current) return
      if (result?.state) applySnapshot(result)
      if (!result?.ok) throw new Error(result?.reason || 'unavailable')
      if (command === 'reset') setIntention('')
    } catch (failure) {
      if (mountedRef.current && requestKey === keyRef.current) {
        setError(failure.message === 'conflict'
          ? (zh ? '专注状态已更新，请再试一次。' : 'Focus has changed. Please try again.')
          : (zh ? '这次操作没有完成，请重试。' : 'That action did not finish. Please retry.'))
      }
    } finally {
      if (mountedRef.current && requestKey === keyRef.current) {
        mutationRef.current = false
        setBusy(false)
      }
    }
  }

  if (!['pig', 'cat', 'dog'].includes(accountContext?.petType) || !accountContext?.hasSession) return null
  const remaining = state ? getFocusSnapshotRemainingMs(snapshot, now) : 0
  const progress = state?.durationMs ? Math.round((1 - remaining / state.durationMs) * 100) : 0
  const active = status === 'running' || status === 'paused'

  return (
    <section id="companion-focus" tabIndex={-1} className="focus-panel" data-pet-type={accountContext.petType} aria-label={zh ? '陪我专注' : 'Focus together'} data-e2e="focus-panel" data-focus-status={state ? status : 'loading'} aria-busy={loading || busy}>
      <div className="focus-heading"><Sprout size={17} aria-hidden="true" /><h2>{zh ? '陪我专注' : 'Focus together'}</h2><span>{zh ? '一小段就好' : 'One little stretch'}</span></div>
      {!state ? (
        <p className="focus-copy" role="status">{loading ? (zh ? '正在找回我们的进度…' : 'Finding our place…') : (zh ? '稍后再一起开始。' : 'We can begin in a moment.')}</p>
      ) : status === 'idle' ? (
        <>
          <p className="focus-copy">{zh ? '选一件小事，我在旁边安静陪你。' : 'Pick one small thing. I will quietly keep you company.'}</p>
          <div className="focus-durations" role="group" aria-label={zh ? '专注时长' : 'Focus duration'}>
            {[15, 25, 45].map((duration) => <button key={duration} type="button" aria-pressed={minutes === duration} onClick={() => setMinutes(duration)} disabled={busy}>{duration}<span>{zh ? '分钟' : 'min'}</span></button>)}
          </div>
          <label className="focus-intention"><span>{zh ? '这次想做什么？（选填）' : 'What is on your mind? (optional)'}</span><input value={intention} maxLength={80} placeholder={zh ? '比如，读几页书' : 'Maybe read a few pages'} onChange={(event) => setIntention(event.target.value)} disabled={busy} data-e2e="focus-intention" /></label>
          <button type="button" className="focus-primary" onClick={() => void act('start')} disabled={busy} data-e2e="focus-start"><Play size={14} aria-hidden="true" />{zh ? '一起开始' : 'Let’s begin'}</button>
        </>
      ) : status === 'completed' ? (
        <div className="focus-completed" role="status">
          <span className="focus-complete-icon"><Check size={23} aria-hidden="true" /></span>
          <h3>{zh ? '这一小段，我们完成啦。' : 'We finished this little stretch.'}</h3>
          {state.intention && <p className="focus-task">{state.intention}</p>}
          <p className="focus-copy">{zh ? '喝口水，伸个懒腰。下一步可以慢慢来。' : 'Some water and a stretch. The next step can wait.'}</p>
          <button type="button" className="focus-primary" onClick={() => void act('reset')} disabled={busy} data-e2e="focus-reset">{zh ? '再选一小段' : 'Choose another little stretch'}</button>
        </div>
      ) : (
        <>
          <div className="focus-clock" style={{ '--focus-progress': `${progress}%` }}><div><span className="focus-time" role="timer" aria-live="off" aria-label={zh ? '剩余时间' : 'Time remaining'} data-e2e="focus-time">{formatFocusTime(remaining)}</span><span className="focus-clock-label" role="status">{status === 'paused' ? (zh ? '歇一会儿也没关系' : 'A pause is okay') : (zh ? '我在这里，慢慢来' : 'I’m here. Take your time.')}</span></div></div>
          {state.intention && <p className="focus-task">{state.intention}</p>}
          <div className="focus-actions">
            <button type="button" className="focus-primary" disabled={busy} onClick={() => void act(status === 'paused' ? 'resume' : 'pause')} data-e2e="focus-toggle">{status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{status === 'paused' ? (zh ? '继续' : 'Continue') : (zh ? '暂停' : 'Pause')}</button>
            <button type="button" className="focus-secondary" disabled={busy} onClick={() => void act('reset')} data-e2e="focus-end">{zh ? '先到这里' : 'Finish here'}</button>
          </div>
        </>
      )}
      {active && <p className="focus-note">{zh ? '关闭面板仍会计时。重要提醒照常送达。' : 'The timer continues with this panel closed. Reminders stay on.'}</p>}
      {error && <div className="focus-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()} disabled={loading || busy} aria-label={zh ? '重新读取专注状态' : 'Reload focus status'}><RefreshCw size={14} aria-hidden="true" /></button></div>}
    </section>
  )
}
