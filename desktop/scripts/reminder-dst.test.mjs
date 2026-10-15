import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const parserUrl = new URL('../src/shared/reminder-parser.js', import.meta.url).href
const scenarios = {
  'America/New_York': [
    ['每周一02:30提醒我开会', '2026-03-08T00:00:00-05:00', '2026-03-09T06:30:00.000Z'],
    ['每个工作日02:30提醒我喝水', '2026-03-08T00:00:00-05:00', '2026-03-09T06:30:00.000Z'],
    ['每天02:30提醒我喝水', '2026-03-08T04:00:00-04:00', '2026-03-09T06:30:00.000Z'],
    ['02:30提醒我喝水', '2026-03-08T04:00:00-04:00', '2026-03-09T06:30:00.000Z'],
    ['每周日02:30提醒我喝水', '2026-03-08T04:00:00-04:00', '2026-03-15T06:30:00.000Z'],
    // The selected day itself has a missing clock time: keep shifting forward.
    ['今天02:30提醒我喝水', '2026-03-08T00:00:00-05:00', '2026-03-08T07:30:00.000Z'],
    ['明天02:30提醒我喝水', '2026-03-07T00:00:00-05:00', '2026-03-08T07:30:00.000Z'],
    // Ambiguous local input keeps the earlier fold and does not repeat today.
    ['每天01:30提醒我喝水', '2026-11-01T00:00:00-04:00', '2026-11-01T05:30:00.000Z'],
    ['每天01:30提醒我喝水', '2026-11-01T01:45:00-04:00', '2026-11-02T06:30:00.000Z'],
  ],
  'Europe/Berlin': [
    ['每周一02:30提醒我开会', '2026-03-29T00:00:00+01:00', '2026-03-30T00:30:00.000Z'],
    ['每个工作日02:30提醒我喝水', '2026-03-29T00:00:00+01:00', '2026-03-30T00:30:00.000Z'],
    ['每天02:30提醒我喝水', '2026-03-29T04:00:00+02:00', '2026-03-30T00:30:00.000Z'],
  ],
  'Australia/Lord_Howe': [
    ['每周一02:15提醒我开会', '2026-10-04T00:00:00+10:30', '2026-10-04T15:15:00.000Z'],
    ['每天02:15提醒我喝水', '2026-10-04T03:00:00+11:00', '2026-10-04T15:15:00.000Z'],
    ['今天02:15提醒我喝水', '2026-10-04T00:00:00+10:30', '2026-10-03T15:45:00.000Z'],
  ],
  'Asia/Shanghai': [
    ['每周一02:30提醒我开会', '2026-03-08T00:00:00+08:00', '2026-03-08T18:30:00.000Z'],
    ['每个工作日02:30提醒我喝水', '2026-03-08T00:00:00+08:00', '2026-03-08T18:30:00.000Z'],
    ['每天02:30提醒我喝水', '2026-03-08T04:00:00+08:00', '2026-03-08T18:30:00.000Z'],
    ['明天九点十五分提醒我开会', '2026-03-08T00:00:00+08:00', '2026-03-09T01:15:00.000Z'],
    ['每周一上午九点零五分提醒我开会', '2026-03-08T00:00:00+08:00', '2026-03-09T01:05:00.000Z'],
  ],
}

// Each child owns its timezone; importing this test never changes other tests'
// process timezone or any operating-system setting.
for (const [timezone, cases] of Object.entries(scenarios)) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { parseReminder } from ${JSON.stringify(parserUrl)}
    for (const [text, now, expected] of ${JSON.stringify(cases)}) {
      const parsed = parseReminder(text, new Date(now))
      assert.equal(parsed.ok, true, text)
      assert.equal(parsed.remindAt.toISOString(), expected, text + ' at ' + now)
    }
  `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, `${timezone}: ${result.stderr || result.error || result.stdout}`)
}

console.log('reminder DST parser tests passed (20 cases across 4 timezones)')
