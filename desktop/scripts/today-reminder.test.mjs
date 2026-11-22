import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { parseTodayReminderDraft, TODAY_REMINDER_PRESETS, TODAY_REMINDER_TITLE_LIMIT } from '../src/shared/today-reminder.js'

test('today reminder presets schedule their elapsed duration from submission even across midnight', () => {
  const now = Date.parse('2026-11-22T23:58:43.425Z')
  const expected = [
    '2026-11-23T00:03:43.425Z',
    '2026-11-23T00:13:43.425Z',
    '2026-11-23T00:58:43.425Z',
  ]
  assert.deepEqual(TODAY_REMINDER_PRESETS, [5, 15, 60])
  for (const [index, minutes] of TODAY_REMINDER_PRESETS.entries()) {
    assert.deepEqual(parseTodayReminderDraft({ title: '  喝水  ', minutes, localTime: 'ignored' }, now), {
      ok: true, title: '喝水', remindAt: expected[index],
    })
  }
})

test('today reminder titles are trimmed and capped at 200 characters', () => {
  const title = '字'.repeat(TODAY_REMINDER_TITLE_LIMIT)
  assert.equal(TODAY_REMINDER_TITLE_LIMIT, 200)
  assert.equal(parseTodayReminderDraft({ title: ` ${title} `, minutes: 5 }, 0).title, title)
  for (const invalidTitle of [undefined, '  ', 12, `${title}字`]) {
    assert.deepEqual(parseTodayReminderDraft({ title: invalidTitle, minutes: 5 }, 0), {
      ok: false, reason: 'invalid_title',
    })
  }
})

test('today reminder rejects an unsupported preset or invalid submit clock', () => {
  for (const minutes of [undefined, '5', 0, 10, 30, Infinity]) {
    assert.deepEqual(parseTodayReminderDraft({ title: 'Water', minutes }, 0), { ok: false, reason: 'invalid_time' })
  }
  for (const now of [NaN, Infinity, 8_640_000_000_000_000]) {
    assert.deepEqual(parseTodayReminderDraft({ title: 'Water', minutes: 5 }, now), { ok: false, reason: 'invalid_time' })
  }
})

test('today reminder custom time follows the device calendar and must still be future at submission', () => {
  const draft = { title: 'Water', minutes: null, localTime: '2026-11-23T00:00' }
  const now = new Date(2026, 10, 22, 23, 59, 30).getTime()
  const midnight = new Date(2026, 10, 23, 0, 0)
  assert.deepEqual(parseTodayReminderDraft(draft, now), {
    ok: true, title: 'Water', remindAt: midnight.toISOString(),
  })
  assert.deepEqual(parseTodayReminderDraft(draft, midnight.getTime()), { ok: false, reason: 'past_time' })
  assert.deepEqual(parseTodayReminderDraft({ ...draft, localTime: '2026-02-30T09:00' }, 0), { ok: false, reason: 'invalid_time' })
  assert.deepEqual(parseTodayReminderDraft({ ...draft, localTime: '' }, now), { ok: false, reason: 'invalid_time' })
})

test('today reminder rejects skipped local times and keeps preset duration across a DST gap', () => {
  const moduleUrl = new URL('../src/shared/today-reminder.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { parseTodayReminderDraft } from ${JSON.stringify(moduleUrl)}
    const now = Date.parse('2026-03-08T06:55:30.000Z')
    const custom = { title: 'Water', minutes: null, localTime: '2026-03-08T02:30' }
    assert.deepEqual(parseTodayReminderDraft(custom, now), { ok: false, reason: 'invalid_time' })
    assert.equal(parseTodayReminderDraft({ ...custom, localTime: '2026-03-08T03:30' }, now).remindAt, '2026-03-08T07:30:00.000Z')
    assert.equal(parseTodayReminderDraft({ title: 'Water', minutes: 15 }, now).remindAt, '2026-03-08T07:10:30.000Z')
  `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
