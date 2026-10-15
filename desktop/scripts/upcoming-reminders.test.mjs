import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { getUpcomingOneTimeReminders, parseReminderReschedule, toReminderLocalInput } from '../src/shared/upcoming-reminders.js'

const moduleUrl = new URL('../src/shared/upcoming-reminders.js', import.meta.url).href

test('upcoming rows contain only the current pet’s untriggered one-time pending reminders', () => {
  const base = { user_id: 7, pet_type: 'pig', status: 'pending', recurrence_type: 'once', series_id: null, triggered_at: null, remind_at: '2026-10-01T08:00:00Z' }
  const rows = [
    { ...base, id: 3 },
    { ...base, id: 2 },
    { ...base, id: 1, remind_at: '2026-09-01T08:00:00Z' },
    { ...base, id: 4, recurrence_type: 'daily', series_id: 12 },
    { ...base, id: 5, series_id: 13 },
    { ...base, id: 6, triggered_at: '2026-10-01T08:00:01Z' },
    { ...base, id: 7, status: 'canceled' },
    { ...base, id: 8, status: 'completed' },
    { ...base, id: 9, pet_type: 'cat' },
    { ...base, id: 10, user_id: 8 },
    { ...base, id: 11, remind_at: 'invalid' },
  ]
  const originalOrder = rows.map((row) => row.id)
  assert.deepEqual(getUpcomingOneTimeReminders(rows, { userId: 7, petType: 'pig' }).map((row) => row.id), [1, 2, 3])
  assert.deepEqual(rows.map((row) => row.id), originalOrder, 'sorting cannot mutate a response shared with another consumer')
  assert.deepEqual(getUpcomingOneTimeReminders(null, { userId: 7, petType: 'pig' }), [])
})

test('a reschedule rejects invalid calendars, missing values and past/equal times', () => {
  for (const input of ['', '2026-02-30T09:00', '2026-13-01T09:00', '2026-01-01T25:00', '2026-01-01T09:60', 'tomorrow']) {
    assert.deepEqual(parseReminderReschedule(input, undefined, 0), { ok: false, reason: 'invalid_time' }, input)
  }
  const now = new Date(2026, 8, 27, 15, 0).getTime()
  assert.deepEqual(parseReminderReschedule('2026-09-27T15:00', undefined, now), { ok: false, reason: 'past_time' })
  assert.deepEqual(parseReminderReschedule('2026-09-27T14:59', undefined, now), { ok: false, reason: 'past_time' })
  assert.equal(toReminderLocalInput('invalid'), '')
})

function runInTimeZone(timeZone, code) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { parseReminderReschedule, toReminderLocalInput } from ${JSON.stringify(moduleUrl)};
    ${code}
  `], { encoding: 'utf8', env: { ...process.env, TZ: timeZone } })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

for (const [timeZone, inputTime, expectedIso] of [
  ['UTC', '2026-01-15T12:05', '2026-01-15T09:45:00.000Z'],
  ['Asia/Shanghai', '2026-01-15T20:05', '2026-01-15T01:45:00.000Z'],
  ['America/New_York', '2026-01-15T07:05', '2026-01-15T14:45:00.000Z'],
  ['Australia/Lord_Howe', '2026-01-15T23:05', '2026-01-14T22:45:00.000Z'],
]) {
  test(`local editor retains original seconds and converts edited time to UTC in ${timeZone}`, () => {
    runInTimeZone(timeZone, `
      const original = '2026-01-15T12:05:42.123Z';
      const now = Date.parse('2026-01-01T00:00:00Z');
      assert.equal(toReminderLocalInput(original), ${JSON.stringify(inputTime)});
      assert.deepEqual(parseReminderReschedule(toReminderLocalInput(original), original, now), { ok: true, remindAt: original });
      assert.deepEqual(parseReminderReschedule('2026-01-15T09:45', original, now), { ok: true, remindAt: ${JSON.stringify(expectedIso)} });
    `)
  })
}

test('DST editing preserves an untouched later fold and rejects a nonexistent local clock', () => {
  runInTimeZone('America/New_York', `
    const original = '2026-11-01T06:30:42.123Z';
    const now = Date.parse('2026-11-01T06:15:00Z');
    assert.equal(toReminderLocalInput(original), '2026-11-01T01:30');
    assert.deepEqual(parseReminderReschedule('2026-11-01T01:30', original, now), { ok: true, remindAt: original });
    assert.deepEqual(parseReminderReschedule('2026-03-08T02:30', undefined, Date.parse('2026-03-01T00:00:00Z')), { ok: false, reason: 'invalid_time' });
  `)
})
