import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { parseReminder } from '../src/shared/reminder-parser.js'

const now = new Date(2026, 6, 6, 8, 0, 0, 123)

test('relative reminders parse whole integer quantities and explicit half-hours', () => {
  for (const [text, minutes, title] of [
    ['10分钟后提醒我喝水', 10, '喝水'],
    ['十分钟后提醒我喝水', 10, '喝水'],
    ['提醒我十分钟后喝水', 10, '喝水'],
    ['半小时后叫我休息', 30, '休息'],
    ['半个小时后叫我休息', 30, '休息'],
    ['两小时后提醒我喝水', 120, '喝水'],
    ['一个小时后提醒我喝水', 60, '喝水'],
    ['一个半小时后提醒我喝水', 90, '喝水'],
    ['1个半小时后提醒我喝水', 90, '喝水'],
    ['两个半小时后提醒我喝水', 150, '喝水'],
    ['二十五分钟后提醒我喝水', 25, '喝水'],
    ['一百二十分钟后提醒我喝水', 120, '喝水'],
    ['一千零八十分钟后提醒我喝水', 1080, '喝水'],
    ['10080分钟后提醒我喝水', 10080, '喝水'],
    ['168小时后提醒我喝水', 10080, '喝水'],
    ['帮我在十分钟后喝水', 10, '喝水'],
    ['请在10分钟后提醒我喝水', 10, '喝水'],
    ['半小时后叫我喝水', 30, '喝水'],
    ['帮我30分钟后喝水', 30, '喝水'],
    ['记得十分钟后叫我起床', 10, '起床'],
    ['帮我在半小时后喝水', 30, '喝水'],
    ['10分钟后提醒我总结三点经验', 10, '总结三点经验'],
    ['10分钟后提醒我写每周报告', 10, '写每周报告'],
  ]) {
    const parsed = parseReminder(text, now)
    assert.equal(parsed.ok, true, text)
    assert.equal(parsed.remindAt.getTime(), now.getTime() + minutes * 60_000, text)
    assert.equal(parsed.title, title, text)
    assert.equal(parsed.sourceText, text, text)
    assert.equal(parsed.recurrenceType, 'once', text)
  }
})

test('invalid relative quantities never match a valid numeric suffix', () => {
  for (const text of [
    '0分钟后提醒我喝水', '零小时后提醒我喝水', '-2小时后提醒我喝水',
    '- 2小时后提醒我喝水', '负两小时后提醒我喝水',
    '1.5小时后提醒我喝水', '1/2小时后提醒我喝水', '1e3小时后提醒我喝水',
    '零点五小时后提醒我喝水', '半分钟后提醒我喝水',
    '10081分钟后提醒我喝水', '169小时后提醒我喝水',
    '1000000000000小时后提醒我喝水', '9007199254740993分钟后提醒我喝水',
    '一亿小时后提醒我喝水', '一百二分钟后提醒我喝水',
    '－2小时后提醒我喝水', '﹣2小时后提醒我喝水',
    '1,5小时后提醒我喝水', '1,500分钟后提醒我喝水',
    '1, 500分钟后提醒我喝水', '一又二分之一小时后提醒我喝水',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'invalid_relative_time' }, text)
  }
})

test('conflicting relative schedules and unsupported recurrence are rejected', () => {
  for (const text of [
    '10分钟后20分钟后提醒我喝水',
    '提醒我10分钟后或者半小时后喝水',
    '1小时30分钟后提醒我喝水',
    '1小时，30分钟后提醒我喝水',
    '一小时、三十分钟后提醒我喝水',
    '十分钟后九点提醒我喝水',
    '提醒我十分钟后或者9:30喝水',
    '明天十分钟后提醒我喝水',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'ambiguous_time' }, text)
  }
  for (const text of ['每天10分钟后提醒我喝水', '每周一半小时后叫我休息']) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'relative_recurrence_unsupported' }, text)
  }
})

test('relative durations require scheduling intent and a real task', () => {
  for (const text of [
    '帮我想半小时后的祝福', '我想知道两小时后会不会开心', '十分钟后喝水',
    '帮我写10分钟后提醒用户休息的文案',
    '帮我解释10分钟后提醒我喝水是什么意思',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'not_reminder' }, text)
  }
  for (const text of [
    '十分钟后提醒我', '提醒我十分钟后', '半小时后叫我', '请在10分钟后提醒我一下',
    '明天九点提醒我', '明天九点提醒', '每天九点',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'missing_task' }, text)
  }
  assert.equal(parseReminder('明天9点有个会议', now).title, '开会')
})

test('explicit past one-time dates reject instead of firing immediately', () => {
  const afternoon = new Date(2026, 6, 6, 15, 0)
  assert.deepEqual(parseReminder('今天九点提醒我喝水', afternoon), { ok: false, reason: 'past_time' })
  assert.deepEqual(parseReminder('今天15:00提醒我喝水', afternoon), { ok: false, reason: 'past_time' })
  assert.equal(parseReminder('九点提醒我喝水', afternoon).remindAt.getTime(), new Date(2026, 6, 7, 9).getTime())
  assert.equal(parseReminder('每天九点提醒我喝水', afternoon).remindAt.getTime(), new Date(2026, 6, 7, 9).getTime())
})

const parserUrl = new URL('../src/shared/reminder-parser.js', import.meta.url).href
for (const [timezone, cases] of Object.entries({
  'Asia/Shanghai': [
    ['十分钟后提醒我喝水', '2026-07-06T23:55:00+08:00', '2026-07-06T16:05:00.000Z'],
  ],
  'America/New_York': [
    ['两小时后提醒我喝水', '2026-03-08T01:30:00-05:00', '2026-03-08T08:30:00.000Z'],
    ['两小时后提醒我喝水', '2026-11-01T00:30:00-04:00', '2026-11-01T06:30:00.000Z'],
  ],
  'Australia/Lord_Howe': [
    ['一个半小时后提醒我喝水', '2026-10-04T01:30:00+10:30', '2026-10-03T16:30:00.000Z'],
  ],
})) {
  test(`relative reminders use elapsed milliseconds across midnight and DST in ${timezone}`, () => {
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { parseReminder } from ${JSON.stringify(parserUrl)}
      for (const [text, now, expected] of ${JSON.stringify(cases)}) {
        const parsed = parseReminder(text, new Date(now))
        assert.equal(parsed.ok, true, text)
        assert.equal(parsed.remindAt.toISOString(), expected, text)
      }
    `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  })
}
