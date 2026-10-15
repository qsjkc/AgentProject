import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReminder } from '../src/shared/reminder-parser.js'

const now = new Date(2026, 6, 6, 8, 0, 0)

test('requests to explain or write reminder text stay in chat for every schedule type', () => {
  for (const text of [
    '帮我解释“明天九点提醒我喝水”是什么意思',
    '帮我写一段明天九点提醒用户休息的文案',
    '帮我翻译“每天上午九点提醒我喝水”',
    '帮我解释“每周三下午三点提醒我开会”是什么意思',
    '请翻译十分钟后提醒我喝水',
    '帮我润色明天九点提醒用户休息的文案',
    '写一段每天9:00提醒用户休息的文案',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'not_reminder' }, text)
  }
  for (const text of [
    '明天九点提醒我解释三点经验',
    '每天九点提醒我写一段文案',
    '每周三九点提醒我翻译材料',
    '十分钟后提醒我润色材料',
  ]) {
    assert.equal(parseReminder(text, now).ok, true, text)
  }
})

test('ordinary requests, recollections, names, and numbered advice stay in chat', () => {
  for (const text of [
    '帮我想一件今天可以期待的小事。',
    '帮我写一封邮件',
    '你还记得我吗',
    '以后叫我小明',
    '帮我总结三点经验',
    '帮我想一点开心的事',
    '请帮我列两点建议',
    '帮我写一点感想',
    '帮我想半小时后的生日祝福',
    '我每天都睡不好',
    '每天都不开心',
    '天天陪我聊聊吧',
    '帮我总结三点交流经验',
    '我有三点交流经验',
    '每天帮我总结三点经验',
    '每周我都觉得很累',
    '每周三都不想上班',
    '工作日总觉得累',
    '帮我想一点每日的小期待',
    '这三点经验，帮我回顾一下',
    '叫我起床',
    '记得喝水',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'not_reminder' }, text)
  }
})

test('clock-qualified assistance and existing compact task reminders remain recognized', () => {
  for (const [text, day, hour, minute, recurrence] of [
    ['帮我明天九点喝水', 7, 9, 0, 'once'],
    ['明天九点帮我喝水', 7, 9, 0, 'once'],
    ['请帮我在明天九点喝水', 7, 9, 0, 'once'],
    ['帮我定在明天九点喝水', 7, 9, 0, 'once'],
    ['记得明天九点喝水', 7, 9, 0, 'once'],
    ['明天九点记得喝水', 7, 9, 0, 'once'],
    ['明天九点叫我起床', 7, 9, 0, 'once'],
    ['叫我明天九点起床', 7, 9, 0, 'once'],
    ['明天9:05帮我吃药', 7, 9, 5, 'once'],
    ['帮我明天9:05吃药', 7, 9, 5, 'once'],
    ['明天9点帮我提醒喝水', 7, 9, 0, 'once'],
    ['下午三点有一个会议', 6, 15, 0, 'once'],
    ['明早九点交材料', 7, 9, 0, 'once'],
    ['每天上午九点喝水', 6, 9, 0, 'daily'],
    ['每周一九点零五分提醒我开会', 6, 9, 5, 'weekly'],
    ['工作日下午三点提醒我交日报', 6, 15, 0, 'weekdays'],
    ['我明天九点有个会议', 7, 9, 0, 'once'],
    ['请你明天九点帮我喝水', 7, 9, 0, 'once'],
    ['每周三下午三点开会', 8, 15, 0, 'weekly'],
    ['每天9:05帮我喝水', 6, 9, 5, 'daily'],
    ['我明天下午三点有一个会议', 7, 15, 0, 'once'],
    ['我今天14:30要交材料', 6, 14, 30, 'once'],
  ]) {
    const parsed = parseReminder(text, now)
    assert.equal(parsed.ok, true, text)
    assert.equal(parsed.remindAt.getTime(), new Date(2026, 6, day, hour, minute).getTime(), text)
    assert.equal(parsed.recurrenceType, recurrence, text)
  }
})

test('explicit reminder requests retain missing-time and recurrence feedback', () => {
  for (const text of [
    '提醒我一下',
    '帮我设置一个喝水提醒',
    '通知我喝水',
    '帮我25点喝水',
    '明天9点60分叫我喝水',
    '每天提醒我喝水',
  ]) {
    assert.deepEqual(parseReminder(text, now), { ok: false, reason: 'missing_time' }, text)
  }
  assert.deepEqual(parseReminder('每周下午三点提醒我周会', now), {
    ok: false, reason: 'missing_recurrence_day',
  })
  assert.deepEqual(parseReminder('每周下午三点喝水', now), {
    ok: false, reason: 'missing_recurrence_day',
  })
})
