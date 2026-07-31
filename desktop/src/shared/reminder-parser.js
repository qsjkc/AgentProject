const CHINESE_HOURS = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

const CHINESE_WEEKDAYS = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
}

function parseHour(rawHour) {
  if (/^\d+$/.test(rawHour)) {
    return Number(rawHour)
  }
  if (rawHour === '十一') return 11
  if (rawHour === '十二') return 12
  return CHINESE_HOURS[rawHour] || null
}

function stripReminderWords(text) {
  return text
    .replace(/每(?:周|星期|礼拜)[一二三四五六日天]/g, '')
    .replace(/每天|每日|天天|每个?工作日|工作日/g, '')
    .replace(/提醒我|通知我|叫我|帮我|记得|到时候|今天|明天|明早|明晚|后天|上午|下午|晚上|早上|中午/g, '')
    .replace(/\d{1,2}[:：]\d{2}/g, '')
    .replace(/[一二两三四五六七八九十]{1,2}点半?/g, '')
    .replace(/\d{1,2}点半?/g, '')
    .replace(/有一个|有个/g, '')
    .replace(/[，。,.?？]/g, '')
    .trim()
}

function parseRecurrence(text) {
  const weeklyMatch = text.match(/每(?:周|星期|礼拜)([一二三四五六日天])/)
  if (weeklyMatch) {
    return {
      type: 'weekly',
      weekday: CHINESE_WEEKDAYS[weeklyMatch[1]],
    }
  }
  if (/每(?:周|星期|礼拜)/.test(text)) {
    return { type: null, reason: 'missing_recurrence_day' }
  }
  if (/每个?工作日|工作日/.test(text)) {
    return { type: 'weekdays', weekday: null }
  }
  if (/每天|每日|天天/.test(text)) {
    return { type: 'daily', weekday: null }
  }
  return { type: 'once', weekday: null }
}

function normalizeTitle(text) {
  const stripped = stripReminderWords(text)
  if (!stripped || stripped === '会议') {
    return '开会'
  }
  return stripped.slice(0, 80)
}

export function parseReminder(input, now = new Date()) {
  const text = String(input || '').trim()
  if (!text) {
    return { ok: false, reason: 'empty' }
  }

  const date = new Date(now)
  const recurrence = parseRecurrence(text)
  if (recurrence.reason) {
    return { ok: false, reason: recurrence.reason }
  }
  if (/后天/.test(text)) {
    date.setDate(date.getDate() + 2)
  } else if (/明天|明早|明晚/.test(text)) {
    date.setDate(date.getDate() + 1)
  }

  let hour = null
  let minute = 0

  const clockMatch = text.match(/(\d{1,2})[:：](\d{2})/)
  const hourMatch = text.match(/(\d{1,2}|十一|十二|[一二两三四五六七八九十])点(半?)/)
  const hasExplicitReminderIntent = /提醒|记得|帮我|叫我|通知我/.test(text)
  const hasTaskIntent = /会议|开会|提交|交|有一个|有个/.test(text)
  const hasTimeExpression = Boolean(clockMatch || hourMatch)
  const hasRecurringIntent = recurrence.type !== 'once'

  if (
    !hasExplicitReminderIntent
    && !hasRecurringIntent
    && !(hasTimeExpression && hasTaskIntent)
  ) {
    return { ok: false, reason: 'not_reminder' }
  }

  if (clockMatch) {
    hour = Number(clockMatch[1])
    minute = Number(clockMatch[2])
  } else if (hourMatch) {
    hour = parseHour(hourMatch[1])
    minute = hourMatch[2] ? 30 : 0
  }

  if (hour === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, reason: 'missing_time' }
  }

  if (/下午|晚上|明晚/.test(text) && hour < 12) {
    hour += 12
  }
  if (/中午/.test(text) && hour < 11) {
    hour += 12
  }

  date.setHours(hour, minute, 0, 0)
  const hasExplicitDate = /明天|明早|明晚|后天|今天/.test(text)
  if (recurrence.type === 'weekly') {
    let daysUntilTarget = (recurrence.weekday - date.getDay() + 7) % 7
    if (daysUntilTarget === 0 && date.getTime() <= now.getTime()) {
      daysUntilTarget = 7
    }
    date.setDate(date.getDate() + daysUntilTarget)
  } else if (recurrence.type === 'weekdays') {
    if (!hasExplicitDate && date.getTime() <= now.getTime()) {
      date.setDate(date.getDate() + 1)
    }
    while (date.getDay() === 0 || date.getDay() === 6 || date.getTime() <= now.getTime()) {
      date.setDate(date.getDate() + 1)
    }
  } else if (!hasExplicitDate && date.getTime() <= now.getTime()) {
    date.setDate(date.getDate() + 1)
  }

  return {
    ok: true,
    title: normalizeTitle(text),
    sourceText: text,
    remindAt: date,
    recurrenceType: recurrence.type,
  }
}

export const parseOneTimeReminder = parseReminder
