const WEEKDAY_LABELS = {
  'zh-CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
}

export function getReminderRecurrenceLabel(
  recurrenceType,
  remindAt,
  language = 'zh-CN',
) {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  if (recurrenceType === 'daily') {
    return locale === 'zh-CN' ? '每天' : 'Daily'
  }
  if (recurrenceType === 'weekdays') {
    return locale === 'zh-CN' ? '工作日' : 'Weekdays'
  }
  if (recurrenceType === 'weekly') {
    const date = new Date(remindAt)
    const weekday = Number.isNaN(date.getTime()) ? null : date.getDay()
    if (weekday === null) {
      return locale === 'zh-CN' ? '每周' : 'Weekly'
    }
    const label = WEEKDAY_LABELS[locale][weekday]
    return locale === 'zh-CN' ? `每${label}` : `Every ${label}`
  }
  return ''
}

export function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
}
