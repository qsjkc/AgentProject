const WEEKDAYS = {
  'zh-CN': ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}

function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone
  } catch {
    // A newer server can know an IANA zone that this desktop's ICU does not.
    return value.trim()
  }
}

export function formatReminderSeriesSchedule(
  series,
  language,
  copy,
  deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const time = `${String(series.local_hour).padStart(2, '0')}:${String(series.local_minute).padStart(2, '0')}`
  let schedule
  if (series.recurrence_type === 'daily') {
    schedule = `${copy.daily} ${time}`
  } else if (series.recurrence_type === 'weekdays') {
    schedule = `${copy.weekdays} ${time}`
  } else {
    const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
    const weekday = WEEKDAYS[locale][series.weekdays?.[0]] || copy.weekly
    schedule = language === 'zh-CN'
      ? `每${weekday} ${time}`
      : `Every ${weekday} ${time}`
  }

  // The weekday and clock belong to the rule's zone, even when the viewer
  // travels. Converting just the clock would misrepresent rules across DST.
  const ruleTimeZone = typeof series.timezone === 'string' ? series.timezone.trim() : ''
  return ruleTimeZone && canonicalTimeZone(ruleTimeZone) !== canonicalTimeZone(deviceTimeZone)
    ? `${schedule} (${ruleTimeZone})`
    : schedule
}
