import { useCallback, useEffect, useRef, useState } from 'react'
import { BookHeart, RefreshCw } from 'lucide-react'

import { captureApiOperationContext } from '../shared/api'
import { createAccountOperationGate, runAccountOperation } from '../shared/pet-account-context'
import { getPetWeeklySummary } from '../shared/pet-relationships-api'
import {
  getPetWeeklySummaryHighlights,
  getPetWeeklySummaryMessage,
  getPetWeeklySummaryPeriod,
} from '../shared/pet-weekly-summary'
import './pet-weekly-summary.css'

export function PetWeeklySummaryPanel({ language, petType, accountContext }) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const currentContextRef = useRef(accountContext)
  const gateRef = useRef(null)
  const pendingRef = useRef(null)
  const refreshedAtRef = useRef(null)
  if (!gateRef.current) gateRef.current = createAccountOperationGate()
  currentContextRef.current = accountContext
  const available = petType === 'pig' && Boolean(accountContext?.userId && accountContext?.session?.token)
  const zh = language === 'zh-CN'

  const load = useCallback(async () => {
    if (!available || pendingRef.current) return
    const request = gateRef.current.begin(currentContextRef.current)
    pendingRef.current = request
    setLoading(true)
    setFailed(false)
    await runAccountOperation({
      gate: gateRef.current,
      requestContext: request,
      getCurrentContext: () => currentContextRef.current,
      operation: async () => {
        const context = await captureApiOperationContext(request, 'pet')
        return getPetWeeklySummary('pig', context)
      },
      onSuccess: (nextSummary) => {
        setSummary(nextSummary)
        refreshedAtRef.current = performance.now()
      },
      onError: () => setFailed(true),
      onFinally: () => setLoading(false),
    })
    if (pendingRef.current === request) pendingRef.current = null
  }, [
    available,
    accountContext?.userId,
    accountContext?.session?.generation,
    accountContext?.session?.token,
    accountContext?.epoch,
  ])

  useEffect(() => {
    setSummary(null)
    refreshedAtRef.current = null
    void load()
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden'
        && (refreshedAtRef.current === null || performance.now() - refreshedAtRef.current >= 60_000)) {
        void load()
      }
    }
    window.addEventListener('focus', refreshWhenVisible)
    window.addEventListener('online', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 5 * 60_000)
    return () => {
      gateRef.current.invalidate()
      pendingRef.current = null
      window.removeEventListener('focus', refreshWhenVisible)
      window.removeEventListener('online', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [load])

  if (!available) return null
  const title = zh ? '上周的我们' : 'Our week together'
  const highlights = getPetWeeklySummaryHighlights(language, summary)
  const period = getPetWeeklySummaryPeriod(language, summary)

  return (
    <section className="pet-weekly-panel" aria-label={title} aria-busy={loading} data-e2e="pet-weekly-summary">
      <div className="pet-weekly-header">
        <h2 className="pet-weekly-title"><BookHeart size={16} aria-hidden="true" />{title}</h2>
        <button
          type="button"
          className="pet-weekly-refresh"
          aria-label={zh ? '刷新上周回忆' : 'Refresh last week’s memories'}
          title={zh ? '刷新上周回忆' : 'Refresh last week’s memories'}
          disabled={loading}
          onClick={() => { void load() }}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {period && <p className="pet-weekly-period" title={summary.timezone}>{period}</p>}
      <div role="status" aria-live="polite">
        {loading && !summary && <p className="pet-weekly-note">{zh ? '正在翻开我们的小本子…' : 'Opening our little notebook…'}</p>}
        {failed && (
          <div className="pet-weekly-error">
            <p>{zh ? '这次没能读到回忆，稍后再试就好。' : 'Our memories could not load. We can try again.'}</p>
            <button type="button" onClick={() => { void load() }} disabled={loading}>
              {zh ? '重试' : 'Try again'}
            </button>
          </div>
        )}
        {!loading && !failed && !summary?.eligible && (
          <p className="pet-weekly-note">{zh
            ? '上周还没有留下相处记录。我们慢慢来，今天的陪伴会留在下周的小本子里。'
            : 'No shared moments were recorded last week. We can take our time; today’s company belongs in next week’s notebook.'}</p>
        )}
      </div>
      {summary?.eligible && (
        <>
          <p className="pet-weekly-message">{getPetWeeklySummaryMessage(language, summary)}</p>
          <dl className="pet-weekly-metrics">
            <div><dt>{zh ? '相处时刻' : 'Moments'}</dt><dd>{summary.interaction_count}</dd></div>
            <div><dt>{zh ? '完成提醒' : 'Reminders done'}</dt><dd>{summary.reminders_completed_count}</dd></div>
            <div><dt>{zh ? '亲密度成长' : 'Intimacy gained'}</dt><dd>+{summary.xp_gained}</dd></div>
          </dl>
          {highlights.length > 0 && (
            <ul className="pet-weekly-highlights">
              {highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
