import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { parseTodayRepeatReminder } from '../src/shared/today-repeat-reminder.js'

test('repeating reminders require a supported cadence and a canonical local clock', () => {
  const now = Date.parse('2026-11-22T06:00:00Z')
  const invalid = { ok: false, reason: 'invalid_time' }
  for (const repeat of [undefined, null, 'once', 'weekly', 'DAILY']) {
    assert.deepEqual(parseTodayRepeatReminder({ repeat, clock: '09:15' }, now), invalid)
  }
  for (const clock of [undefined, 915, '9:15', ' 09:15', '09:15\n', '09:15:00', '24:00', '09:60', '１２:３０']) {
    assert.deepEqual(parseTodayRepeatReminder({ repeat: 'daily', clock }, now), invalid)
  }
  for (const invalidNow of [NaN, Infinity, 8_640_000_000_000_001]) {
    assert.deepEqual(parseTodayRepeatReminder({ repeat: 'daily', clock: '09:15' }, invalidNow), invalid)
  }
  assert.deepEqual(parseTodayRepeatReminder(null, now), invalid)
})

const schedules = {
  'Asia/Shanghai': [
    ['before the selected minute', 'weekdays', '09:15', '2026-11-20T01:14:59.999Z', '2026-11-20T01:15:00.000Z'],
    ['exactly at the selected minute on Friday', 'weekdays', '09:15', '2026-11-20T01:15:00Z', '2026-11-23T01:15:00.000Z'],
    ['on Saturday with daily cadence', 'daily', '00:00', '2026-11-21T15:59:59Z', '2026-11-21T16:00:00.000Z'],
    ['on Saturday with weekday cadence', 'weekdays', '09:15', '2026-11-21T00:00:00Z', '2026-11-23T01:15:00.000Z'],
    ['on New Year’s Eve', 'weekdays', '09:15', '2026-12-31T10:00:00Z', '2027-01-01T01:15:00.000Z'],
  ],
  'America/New_York': [
    ['when UTC has reached the weekend and the device has not', 'weekdays', '21:00', '2026-06-13T00:30:00Z', '2026-06-13T01:00:00.000Z'],
    ['over a weekend with a spring offset change', 'weekdays', '09:15', '2026-03-06T22:00:00Z', '2026-03-09T13:15:00.000Z'],
    ['when the requested time does not exist on the first date', 'daily', '02:30', '2026-03-08T06:55:00Z', '2026-03-09T06:30:00.000Z'],
    ['before a fall clock repeats', 'daily', '01:30', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00.000Z'],
    ['after the first instance of a fall clock', 'daily', '01:30', '2026-11-01T05:45:00Z', '2026-11-02T06:30:00.000Z'],
  ],
  'Australia/Lord_Howe': [
    ['when the first date skips the requested half hour', 'daily', '02:15', '2026-10-03T14:30:00Z', '2026-10-04T15:15:00.000Z'],
  ],
}

for (const [zone, cases] of Object.entries(schedules)) {
  test(`repeating reminders use the device’s local dates and time zone in ${zone}`, () => {
    const moduleUrl = new URL('../src/shared/today-repeat-reminder.js', import.meta.url).href
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { parseTodayRepeatReminder } from ${JSON.stringify(moduleUrl)}
      for (const [label, repeat, clock, current, remindAt] of ${JSON.stringify(cases)}) {
        assert.deepEqual(parseTodayRepeatReminder({ repeat, clock }, Date.parse(current)), {
          ok: true, remindAt, recurrenceType: repeat, recurrenceTimezone: ${JSON.stringify(zone)},
        }, label)
      }
    `], { encoding: 'utf8', env: { ...process.env, TZ: zone } })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
}
