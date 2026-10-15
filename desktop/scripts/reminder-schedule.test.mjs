import assert from 'node:assert/strict'
import test from 'node:test'
import { formatReminderSeriesSchedule } from '../src/shared/reminder-schedule.js'

const copy = {
  'zh-CN': { daily: '每天', weekdays: '工作日', weekly: '每周' },
  en: { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' },
}
const series = {
  recurrence_type: 'weekly',
  local_hour: 9,
  local_minute: 0,
  weekdays: [0],
  timezone: 'Asia/Shanghai',
}
const format = (rule, language, zone) => formatReminderSeriesSchedule(rule, language, copy[language], zone)

test('traveling viewers see the rule zone without changing its weekday or clock', () => {
  assert.equal(format(series, 'en', 'America/New_York'), 'Every Monday 09:00 (Asia/Shanghai)')
  assert.equal(format(series, 'zh-CN', 'America/New_York'), '每周一 09:00 (Asia/Shanghai)')
  const actualLocal = new Intl.DateTimeFormat('en', {
    timeZone: 'America/New_York', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date('2026-09-28T01:00:00Z'))
  assert.equal(actualLocal, 'Sunday 21:00')
})

test('daily and weekday rules also identify their original zone', () => {
  assert.equal(format({ ...series, recurrence_type: 'daily', local_minute: 5 }, 'en', 'UTC'), 'Daily 09:05 (Asia/Shanghai)')
  assert.equal(format({ ...series, recurrence_type: 'weekdays' }, 'zh-CN', 'UTC'), '工作日 09:00 (Asia/Shanghai)')
})

test('same zones and equivalent IANA aliases keep the existing compact label', () => {
  assert.equal(format(series, 'en', 'Asia/Shanghai'), 'Every Monday 09:00')
  assert.equal(format({ ...series, timezone: 'Asia/Kolkata' }, 'en', 'Asia/Calcutta'), 'Every Monday 09:00')
  assert.equal(format({ ...series, timezone: 'Etc/UTC' }, 'en', 'UTC'), 'Every Monday 09:00')
})

test('DST rules retain their IANA identity instead of a season-specific offset', () => {
  const rule = { ...series, timezone: 'America/New_York', local_hour: 8 }
  for (const next_occurrence_at of ['2026-01-05T13:00:00Z', '2026-07-06T12:00:00Z']) {
    assert.equal(format({ ...rule, next_occurrence_at }, 'en', 'Asia/Shanghai'), 'Every Monday 08:00 (America/New_York)')
  }
})

test('missing legacy zones and unfamiliar server zones do not break the panel', () => {
  assert.equal(format({ ...series, timezone: undefined }, 'en', 'UTC'), 'Every Monday 09:00')
  assert.equal(format({ ...series, timezone: 'Future/Server_Zone' }, 'en', 'UTC'), 'Every Monday 09:00 (Future/Server_Zone)')
})

test('the default comparison uses the runtime device zone', () => {
  const runtimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(format({ ...series, timezone: runtimeZone }, 'en'), 'Every Monday 09:00')
})
