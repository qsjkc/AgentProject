import { FormEvent, useCallback, useEffect, useState } from 'react'

import { getErrorMessage } from '../lib/errors'
import { formatRetentionRate, formatReviewPeriod } from '../lib/retention'
import { adminApi } from '../services'
import type { AdminWeeklyReviewFunnelResponse, PetType } from '../types'

const petOptions: Array<{ value: PetType; label: string }> = [
  { value: 'pig', label: '小猪' },
  { value: 'cat', label: '小猫' },
  { value: 'dog', label: '小狗' },
]
const weekOptions = [4, 8, 12, 26, 52]
const petLabels: Record<PetType, string> = {
  pig: '小猪',
  cat: '小猫',
  dog: '小狗',
}

export default function AdminWeeklyReviewFunnel() {
  const [petType, setPetType] = useState<PetType>('pig')
  const [limit, setLimit] = useState(12)
  const [loadedLimit, setLoadedLimit] = useState(12)
  const [response, setResponse] = useState<AdminWeeklyReviewFunnelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadFunnel = useCallback(async (nextPetType: PetType, nextLimit: number) => {
    setLoading(true)
    setError('')
    try {
      const nextResponse = await adminApi.getWeeklyReviewFunnel(nextPetType, nextLimit)
      setResponse(nextResponse)
      setLoadedLimit(nextLimit)
    } catch (err) {
      setError(getErrorMessage(err, '加载周回顾漏斗失败。'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFunnel('pig', 12)
  }, [loadFunnel])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    await loadFunnel(petType, limit)
  }

  return (
    <section
      aria-labelledby="weekly-review-funnel-heading"
      aria-busy={loading}
      className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Weekly Review Funnel</div>
          <h2 id="weekly-review-funnel-heading" className="mt-4 text-2xl font-semibold text-slate-950">
            周回顾留存漏斗
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
            按周查看生成、展示、已读和后续互动的聚合人数与转化率，不展示单个用户的行为明细。
          </p>
        </div>

        {response && (
          <div className="rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-600">
            已加载：{petLabels[response.pet_type]} · 最近 {loadedLimit} 周
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="mb-2 block text-sm text-slate-600">宠物</span>
          <select
            value={petType}
            onChange={(event) => setPetType(event.target.value as PetType)}
            disabled={loading}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {petOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm text-slate-600">最近周数</span>
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            disabled={loading}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {weekOptions.map((option) => (
              <option key={option} value={option}>
                最近 {option} 周
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={loading}
          className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? '加载中...' : '查询漏斗'}
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-5 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {response ? `刷新失败，当前仍显示上次成功结果。${error}` : error}
        </div>
      )}

      {loading && response && (
        <div role="status" className="mt-5 rounded-2xl bg-sky-50 px-4 py-3 text-sm text-sky-700">
          正在刷新漏斗，当前暂时保留上次结果。
        </div>
      )}

      {loading && !response ? (
        <div role="status" className="mt-6 rounded-2xl bg-slate-50 px-5 py-8 text-sm text-slate-500">
          正在加载周回顾漏斗...
        </div>
      ) : response?.items.length === 0 ? (
        <div className="mt-6 rounded-2xl bg-slate-50 px-5 py-8 text-sm text-slate-500">
          {petLabels[response.pet_type]}最近 {loadedLimit} 周还没有周回顾留存数据。
        </div>
      ) : response ? (
        <div
          tabIndex={0}
          aria-label="周回顾漏斗表格，可横向滚动查看全部字段"
          className="mt-6 overflow-x-auto focus:outline-none focus:ring-2 focus:ring-slate-300 focus:ring-offset-2"
        >
          <table className="min-w-[980px] border-separate border-spacing-y-3">
            <caption className="sr-only">
              {petLabels[response.pet_type]}最近 {loadedLimit} 周的周回顾聚合留存漏斗
            </caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-slate-500">
                <th scope="col" className="px-4">周期</th>
                <th scope="col" className="px-4">生成</th>
                <th scope="col" className="px-4">展示</th>
                <th scope="col" className="px-4">已读</th>
                <th scope="col" className="px-4">后续互动</th>
                <th scope="col" className="px-4">互动类型</th>
              </tr>
            </thead>
            <tbody>
              {response.items.map((item) => (
                <tr key={item.review_key} className="bg-slate-50 text-sm text-slate-700">
                  <th scope="row" className="rounded-l-[1.5rem] px-4 py-4 text-left font-medium text-slate-950">
                    {formatReviewPeriod(item.review_key)}
                  </th>
                  <td className="px-4 py-4">
                    <div className="text-lg font-semibold text-slate-950">{item.generated_users}</div>
                    <div className="mt-1 text-xs text-slate-500">去重用户</div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-lg font-semibold text-slate-950">{item.shown_users}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      生成 → 展示 {formatRetentionRate(item.shown_from_generated_rate)}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-lg font-semibold text-slate-950">{item.seen_users}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      展示 → 已读 {formatRetentionRate(item.seen_from_shown_rate)}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-lg font-semibold text-slate-950">{item.follow_up_users}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      已读 → 后续 {formatRetentionRate(item.follow_up_from_seen_rate)}
                    </div>
                  </td>
                  <td className="rounded-r-[1.5rem] px-4 py-4">
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                        照料 {item.follow_up_care_users}
                      </span>
                      <span className="rounded-full bg-sky-100 px-3 py-1 text-sky-800">
                        聊天 {item.follow_up_chat_users}
                      </span>
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">
                        提醒 {item.follow_up_reminder_users}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-5 text-xs leading-6 text-slate-500">
        三类互动人数分别去重，同一用户可能出现在多个类别中，因此分类人数不能直接相加为后续互动总人数。
      </p>
    </section>
  )
}
