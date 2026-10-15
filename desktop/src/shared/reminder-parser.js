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
const HOUR_EXPRESSION = /(\d+|[零〇一二两三四五六七八九十]+)点(?:(半)|([\d零〇一二两三四五六七八九十]+)分)?/
const RELATIVE_TIME_EXPRESSION = /([+\-−－﹣负]?\s*(?:\d[\d\s.,，/／eE+\-−－﹣]*|[零〇一二两三四五六七八九十百千万亿点又分之]+|半))(个?)(半?)(分钟|小时)(?:以|之)?后/g
const MAX_RELATIVE_MINUTES = 7 * 24 * 60
const EMPTY_TASK = /^(?:\s|[，,。.!！?？:：]|请你?|麻烦你?|提醒我?|通知我|叫我|帮我|记得|在|于|到|一下|一个|一条|设置|安排|定|我|吧|呀|哦)*$/

function parseHour(rawHour) {
  if (/^\d+$/.test(rawHour)) {
    return Number(rawHour)
  }
  if (rawHour === '十一') return 11
  if (rawHour === '十二') return 12
  return CHINESE_HOURS[rawHour] || null
}

function parseMinute(rawMinute) {
  if (/^\d+$/.test(rawMinute)) return Number(rawMinute)
  if (/^[零〇]$/.test(rawMinute)) return 0
  if (/^[零〇]?[一二两三四五六七八九]$/.test(rawMinute)) {
    return CHINESE_HOURS[rawMinute.slice(-1)]
  }
  const tens = rawMinute.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/)
  if (tens) {
    return (tens[1] ? CHINESE_HOURS[tens[1]] : 1) * 10 + (CHINESE_HOURS[tens[2]] || 0)
  }
  return null
}

function stripReminderWords(text) {
  return text
    .replace(/每(?:周|星期|礼拜)[一二三四五六日天]/g, '')
    .replace(/每天|每日|天天|每个?工作日|工作日/g, '')
    .replace(/提醒我|通知我|叫我|帮我|记得|到时候|今天|明天|明早|明晚|后天|上午|下午|晚上|早上|中午/g, '')
    .replace(HOUR_EXPRESSION, '')
    .replace(/\d{1,2}[:：]\d{2}/g, '')
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
  return normalizeTaskTitle(stripReminderWords(text))
}

function normalizeTaskTitle(text) {
  const stripped = text.replace(/^[\s，,。.!！?？:：]+|[\s，,。.!！?？:：]+$/g, '')
  if (EMPTY_TASK.test(stripped)) return null
  if (/^(?:有一个|有个)?会议$/.test(stripped)) return '开会'
  return stripped.slice(0, 80)
}

function hasScheduledTime(text, timeMatch) {
  if (!timeMatch) return false
  const beforeTime = text.slice(0, timeMatch.index).replace(/每(?:周|星期|礼拜)[一二三四五六日天]/g, ' ')
  // Without an explicit reminder command, require a scheduling phrase before
  // the time. "我明天三点有个会议" qualifies; "总结三点交流经验" is
  // numbered advice even though it contains both 点 and 交.
  return /^(?:\s|[，,]|我(?:要|会)?|请你?|麻烦你?|帮我|叫我|记得|在|于|到|定在|设置在|安排在|今天|明天|后天|明早|明晚|上午|下午|晚上|早上|中午|凌晨|每天|每日|天天|每个?工作日|工作日|每(?:周|星期|礼拜))*$/.test(beforeTime)
}

function hasRelativeSchedulingPrefix(text, timeMatch) {
  // The scheduling phrase must precede the duration. A command mentioned in
  // requested prose ("帮我写10分钟后提醒用户休息的文案") is still chat.
  const prefix = text.slice(0, timeMatch.index)
    .replace(/提醒我?|通知我/g, '')
    .replace(/(?:\d+|[零〇一二两三四五六七八九十百千万]+|半)(?:个?半)?(?:分钟|小时)(?:\s|[，,、]|和|又|加|零)*/g, '')
    .replace(/\d{1,2}[:：]\d{2}/g, '')
    .replace(HOUR_EXPRESSION, '')
  return hasScheduledTime(prefix, { index: prefix.length })
}

function formatChineseInteger(value) {
  const digits = '零一二三四五六七八九'
  const units = ['', '十', '百', '千', '万']
  const written = String(value)
  let result = ''
  let pendingZero = false
  for (let index = 0; index < written.length; index += 1) {
    const digit = Number(written[index])
    const power = written.length - index - 1
    if (!digit) {
      pendingZero = Boolean(result)
      continue
    }
    if (pendingZero) result += '零'
    result += digit === 1 && power === 1 && !result ? '十' : digits[digit] + units[power]
    pendingZero = false
  }
  return result || '零'
}

function parseDurationInteger(raw) {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return Number.isSafeInteger(value) ? value : null
  }
  const normalized = raw.replace(/两/g, '二').replace(/〇/g, '零').replace(/^一十/, '十')
  if (!/^[零一二三四五六七八九十百千万]+$/.test(normalized)) return null
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let value = 0
  let digit = 0
  let previousUnit = Infinity
  for (const character of normalized) {
    if (units[character]) {
      if (units[character] >= previousUnit) return null
      previousUnit = units[character]
      value += (digit || 1) * previousUnit
      digit = 0
    } else {
      digit = '零一二三四五六七八九'.indexOf(character)
    }
  }
  value += digit
  // Reject ambiguous shorthand (一百二) instead of silently choosing 102/120.
  return value <= MAX_RELATIVE_MINUTES && formatChineseInteger(value) === normalized ? value : null
}

function parseRelativeReminder(text, matches, now) {
  if (matches.length !== 1) return { ok: false, reason: 'ambiguous_time' }
  const match = matches[0]
  const raw = match[1].trim()
  const hasExtraHalf = Boolean(match[3])
  const unit = match[4]
  const quantity = raw === '半' ? 0.5 : parseDurationInteger(raw)
  const minutes = (quantity + (hasExtraHalf ? 0.5 : 0)) * (unit === '小时' ? 60 : 1)
  const leadingCharacter = text[match.index - 1] || ''
  if (
    quantity === null || (raw === '半' && hasExtraHalf)
    || (hasExtraHalf && unit !== '小时') || (match[2] && unit !== '小时')
    || /[\d.\/／+\-−－﹣负eE点分之]/.test(leadingCharacter)
    || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_RELATIVE_MINUTES
    || !Number.isFinite(now.getTime())
  ) return { ok: false, reason: 'invalid_relative_time' }

  const before = text.slice(0, match.index)
  const after = text.slice(match.index + match[0].length)
  const commandAfter = after.match(/^(?:\s|[，,]|请你?|麻烦你?)*(?:提醒我?|通知我|叫我|帮我|记得)/)
  const schedulingText = before + match[0] + (commandAfter?.[0] || '')
  let task = commandAfter ? after.slice(commandAfter[0].length) : after
  if (!commandAfter && !EMPTY_TASK.test(before)) task = before + task
  task = task.replace(/^(?:\s|[，,]|请你?|麻烦你?)*(?:提醒我?|通知我|叫我|帮我|记得)/, '')

  if (parseRecurrence(schedulingText).type !== 'once') {
    return { ok: false, reason: 'relative_recurrence_unsupported' }
  }
  const writtenClock = (value) => value.match(/\d{1,2}[:：]\d{2}/) || value.match(HOUR_EXPRESSION)
  const extraDuration = /(?:\d+|[零〇一二两三四五六七八九十百千万]+|半)(?:个?半)?(?:分钟|小时)(?:\s|[，,、]|和|又|加|零)*$/.test(before)
  const taskHasClock = task.split(/[，,。；;]|或者|还是|或/).some((part) => hasScheduledTime(part.trim(), writtenClock(part.trim())))
  const schedulingWithoutDuration = before + (commandAfter?.[0] || '')
  if (
    extraDuration || writtenClock(schedulingWithoutDuration) || taskHasClock
    || /今天|明天|后天|明早|明晚|上午|下午|晚上|早上|中午|凌晨/.test(schedulingText)
  ) return { ok: false, reason: 'ambiguous_time' }
  const title = normalizeTaskTitle(task)
  if (!title) return { ok: false, reason: 'missing_task' }
  return {
    ok: true,
    title,
    sourceText: text,
    remindAt: new Date(now.getTime() + minutes * 60_000),
    recurrenceType: 'once',
  }
}

export function parseReminder(input, now = new Date()) {
  const text = String(input || '').trim()
  if (!text) {
    return { ok: false, reason: 'empty' }
  }
  // A leading request to discuss or compose content does not execute a reminder
  // quoted in that content. Only inspect the request prefix, never its task.
  if (/^(?:(?:请你?|麻烦你?|帮我|替我|给我|为我)\s*)*(?:解释|翻译|分析|总结|讨论|改写|润色|写|生成)/.test(text)) {
    return { ok: false, reason: 'not_reminder' }
  }

  const date = new Date(now)
  const recurrence = parseRecurrence(text)
  if (/后天/.test(text)) {
    date.setDate(date.getDate() + 2)
  } else if (/明天|明早|明晚/.test(text)) {
    date.setDate(date.getDate() + 1)
  }

  let hour = null
  let minute = 0

  // Keep the weekday's numeral out of adjacent clock text: 周一九点 is 9,
  // not the invalid Chinese hour 一九. Recurrence still uses the full input.
  const clockText = text.replace(/每(?:周|星期|礼拜)[一二三四五六日天]/g, ' ')
  const clockMatch = clockText.match(/(\d{1,2})[:：](\d{2})/)
  const hourMatch = clockText.match(HOUR_EXPRESSION)
  const relativeMatches = [...text.matchAll(RELATIVE_TIME_EXPRESSION)]
  const relativeTimeMatch = relativeMatches[0]
  if (relativeTimeMatch && !hasRelativeSchedulingPrefix(text, relativeTimeMatch)) {
    return { ok: false, reason: 'not_reminder' }
  }
  const hasScheduledClock = hasScheduledTime(clockText, clockMatch || hourMatch)
  const hasExplicitReminderIntent = /提醒|通知我/.test(text)
    || (/帮我|叫我|记得/.test(text)
      && (hasScheduledClock || hasScheduledTime(text, relativeTimeMatch)))
  const hasTaskIntent = /会议|开会|提交|交|有一个|有个/.test(text)
  // Frequency alone is common in companion chat ("我每天都睡不好").
  const hasRecurringIntent = recurrence.type !== 'once' && hasScheduledClock

  if (
    !hasExplicitReminderIntent
    && !hasRecurringIntent
    && !(hasScheduledClock && hasTaskIntent)
  ) {
    return { ok: false, reason: 'not_reminder' }
  }
  if (relativeMatches.length > 0) return parseRelativeReminder(text, relativeMatches, new Date(now))
  if (recurrence.reason) {
    return { ok: false, reason: recurrence.reason }
  }

  if (clockMatch) {
    hour = Number(clockMatch[1])
    minute = Number(clockMatch[2])
  } else if (hourMatch) {
    hour = parseHour(hourMatch[1])
    minute = hourMatch[2] ? 30 : hourMatch[3] ? parseMinute(hourMatch[3]) : 0
  }

  if (hour === null || hour < 0 || hour > 23 || minute === null || minute < 0 || minute > 59) {
    return { ok: false, reason: 'missing_time' }
  }

  if (/下午|晚上|明晚/.test(text) && hour < 12) {
    hour += 12
  }
  if (/中午/.test(text) && hour < 11) {
    hour += 12
  }

  date.setHours(hour, minute, 0, 0)
  const moveByDays = (days) => {
    date.setDate(date.getDate() + days)
    // A DST gap may normalize today's clock (02:30 -> 03:30). Restore the
    // requested time on each new date instead of carrying that shift forward.
    date.setHours(hour, minute, 0, 0)
  }
  const hasExplicitDate = /明天|明早|明晚|后天|今天/.test(text)
  if (recurrence.type === 'weekly') {
    let daysUntilTarget = (recurrence.weekday - date.getDay() + 7) % 7
    if (daysUntilTarget === 0 && date.getTime() <= now.getTime()) {
      daysUntilTarget = 7
    }
    moveByDays(daysUntilTarget)
  } else if (recurrence.type === 'weekdays') {
    if (!hasExplicitDate && date.getTime() <= now.getTime()) {
      moveByDays(1)
    }
    while (date.getDay() === 0 || date.getDay() === 6 || date.getTime() <= now.getTime()) {
      moveByDays(1)
    }
  } else if (!hasExplicitDate && date.getTime() <= now.getTime()) {
    moveByDays(1)
  }

  const title = normalizeTitle(text)
  if (!title) return { ok: false, reason: 'missing_task' }
  if (recurrence.type === 'once' && hasExplicitDate && date.getTime() <= now.getTime()) {
    return { ok: false, reason: 'past_time' }
  }
  return {
    ok: true,
    title,
    sourceText: text,
    remindAt: date,
    recurrenceType: recurrence.type,
  }
}

export const parseOneTimeReminder = parseReminder
