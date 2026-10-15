import assert from 'node:assert/strict'
import { parseReminder } from '../src/shared/reminder-parser.js'

const now = new Date(2026, 6, 6, 8, 0, 0)
for (const [text, day, hour, minute, recurrence] of [
  ['每周一九点提醒我开会', 6, 9, 0, 'weekly'],
  ['每周一九点零五分提醒我开会', 6, 9, 5, 'weekly'],
  ['每周五六点提醒我开会', 10, 6, 0, 'weekly'],
  ['每周三十二点十分提醒我开会', 8, 12, 10, 'weekly'],
  ['每星期二十一点半提醒我开会', 7, 11, 30, 'weekly'],
  ['每礼拜六两点十五分提醒我开会', 11, 2, 15, 'weekly'],
  ['每周日九点提醒我开会', 12, 9, 0, 'weekly'],
  ['每周五6:45提醒我开会', 10, 6, 45, 'weekly'],
  ['每周一下午三点零五分提醒我开会', 6, 15, 5, 'weekly'],
  ['每天九点零五分提醒我开会', 6, 9, 5, 'daily'],
]) {
  const parsed = parseReminder(text, now)
  assert.equal(parsed.ok, true, text)
  assert.equal(parsed.title, '开会', text)
  assert.equal(parsed.recurrenceType, recurrence, text)
  assert.equal(parsed.remindAt.getTime(), new Date(2026, 6, day, hour, minute, 0).getTime(), text)
}

for (const text of [
  '每周一一九点提醒我开会',
  '每周五二十五点提醒我开会',
  '每周一九点六十分提醒我开会',
  '每周五6点100分提醒我开会',
  '每周一25:15提醒我开会',
]) {
  const parsed = parseReminder(text, now)
  assert.equal(parsed.ok, false, text)
  assert.equal(parsed.reason, 'missing_time', text)
}

console.log('weekly reminder clock tests passed (10 valid and 5 invalid expressions)')
