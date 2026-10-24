import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { getFocusHistoryRefreshDelay, getFocusHistorySummary, summarizeFocusHistory } from '../src/shared/focus-history.js'

const context = { server: 'https://example.test/api/v1', hasSession: true, userId: 1, petType: 'pig', session: { generation: 2 } }
const now = new Date(2026, 9, 24, 12).getTime()
const record = (id, completedAt = now, minutes = 25, intention = '读几页书') => ({ id, completedAt, durationMs: minutes * 60000, intention })
const snapshot = (history) => ({ ...context, generation: 2, state: { status: 'idle' }, history })
const empty = { todayCount: 0, todayMinutes: 0, recent: [] }

test('focus history counts the local completion date and shows only the latest three of seven calendar dates', () => {
  const midnight = new Date(2026, 9, 24).getTime()
  const earliest = new Date(2026, 9, 18).getTime()
  const history = [
    record('today-start', midnight, 15),
    record('previous-day', midnight - 1, 45),
    record('earliest', earliest),
    record('outside-window', earliest - 1),
    record('today-latest', now, 25),
    record('today-middle', midnight + 60000, 45),
    record('today-second', midnight + 120000, 15),
    record('future', now + 1),
  ]
  const result = summarizeFocusHistory(history, now)
  assert.equal(result.todayCount, 4)
  assert.equal(result.todayMinutes, 100)
  assert.deepEqual(result.recent.map((entry) => entry.id), ['today-latest', 'today-second', 'today-middle'])
  assert.deepEqual(summarizeFocusHistory([record('earliest', earliest), record('outside-window', earliest - 1)], now).recent.map((entry) => entry.id), ['earliest'])
})

test('legacy snapshots and malformed history safely produce an empty summary', () => {
  assert.deepEqual(getFocusHistorySummary(snapshot(undefined), context, now), empty)
  for (const value of [undefined, null, {}, 'history', 1]) {
    assert.deepEqual(summarizeFocusHistory(value, now), empty)
  }
  for (const clock of [NaN, Infinity, -Infinity, '2026-10-24', 1e30]) {
    assert.deepEqual(summarizeFocusHistory([record('valid')], clock), empty)
  }
  const invalid = [
    null, undefined, {}, record('', now), record('  ', now), record(123, now),
    record('nan', NaN), record('infinity', Infinity), record('string', String(now)),
    record('negative-duration', now, -25), record('zero', now, 0), record('unsupported', now, 30),
    { ...record('string-duration'), durationMs: '1500000' },
    record('invalid-date', 1e30), record('future', now + 1),
  ]
  assert.deepEqual(summarizeFocusHistory(invalid, now), empty)
})

test('history deduplicates completed sessions without mutating input and bounds display copy', () => {
  const history = Object.freeze([
    Object.freeze(record('duplicate', now - 1000, 15, 'old')),
    Object.freeze(record('duplicate', now, 25, ` ${'读'.repeat(100)} `)),
    Object.freeze(record('no-intention', now - 1, 45, null)),
  ])
  const result = summarizeFocusHistory(history, now)
  assert.equal(result.todayCount, 2)
  assert.equal(result.todayMinutes, 70)
  assert.equal(result.recent[0].intention, '读'.repeat(80))
  assert.equal(result.recent[1].intention, '')
  assert.equal(history[0].intention, 'old')
  result.recent[0].intention = 'changed display'
  assert.equal(history[1].intention, ` ${'读'.repeat(100)} `)
})

test('history is hidden immediately across account, server, pet, session and logout boundaries', () => {
  const value = snapshot([record('private')])
  assert.equal(getFocusHistorySummary(value, context, now).todayCount, 1)
  for (const next of [
    { ...context, userId: 2 },
    { ...context, server: 'https://other.test/api/v1' },
    { ...context, petType: 'cat' },
    { ...context, session: { generation: 3 } },
    { ...context, hasSession: false },
    null,
  ]) {
    assert.deepEqual(getFocusHistorySummary(value, next, now), empty)
  }
  assert.deepEqual(getFocusHistorySummary(null, context, now), empty)
})

test('midnight updates totals in idle, paused, completed and running states while keeping recent work visible', () => {
  const midnight = new Date(2026, 9, 25).getTime()
  for (const status of ['idle', 'paused', 'completed', 'running']) {
    const value = { ...snapshot([record('yesterday', midnight - 1)]), state: { status } }
    assert.equal(getFocusHistorySummary(value, context, midnight - 1).todayCount, 1)
    const afterMidnight = getFocusHistorySummary(value, context, midnight)
    assert.equal(afterMidnight.todayCount, 0)
    assert.equal(afterMidnight.todayMinutes, 0)
    assert.equal(afterMidnight.recent[0].id, 'yesterday')
  }
})

test('calendar refresh wakes just after midnight and periodically detects clock or timezone changes', () => {
  const midnight = new Date(2026, 9, 25).getTime()
  assert.equal(getFocusHistoryRefreshDelay(midnight - 500), 501)
  assert.equal(getFocusHistoryRefreshDelay(midnight), 60000)
  assert.equal(getFocusHistoryRefreshDelay(now), 60000)
  for (const value of [NaN, Infinity, 'bad', 1e30, 8640000000000000]) {
    assert.equal(getFocusHistoryRefreshDelay(value), 60000)
  }
})

test('seven local calendar dates and midnight work in UTC, Asia and both daylight-saving transitions', () => {
  const moduleUrl = new URL('../src/shared/focus-history.js', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict'
    import { summarizeFocusHistory, getFocusHistoryRefreshDelay } from ${JSON.stringify(moduleUrl)}
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.TZ)
    for (const [month, day] of [[2, 12], [10, 5]]) {
      const clock = new Date(2026, month, day, 12).getTime()
      const start = new Date(2026, month, day - 6).getTime()
      const today = new Date(2026, month, day).getTime()
      const make = (id, at) => ({ id, completedAt: at, durationMs: 15 * 60000, intention: '' })
      const summary = summarizeFocusHistory([make('first', start), make('too-old', start - 1), make('today', today), make('yesterday', today - 1)], clock)
      assert.equal(summary.todayCount, 1)
      assert.equal(summary.todayMinutes, 15)
      assert.deepEqual(summary.recent.map(entry => entry.id), ['today', 'yesterday', 'first'])
      assert.equal(getFocusHistoryRefreshDelay(today - 500), 501)
    }
  `
  for (const timezone of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.status, 0, `${timezone}: ${result.stderr || result.error || result.stdout}`)
  }
})
