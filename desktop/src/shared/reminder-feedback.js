const PARSE_FEEDBACK = {
  missing_time: {
    'zh-CN': '还差一个有效时间，请补充完整，例如“十分钟后提醒我喝水”。',
    en: 'Add a valid time to your reminder. For example, enter “十分钟后提醒我喝水”.',
  },
  missing_recurrence_day: {
    'zh-CN': '请补充每周几提醒，例如“每周一九点提醒我喝水”。',
    en: 'Choose a weekday for your weekly reminder. For example, enter “每周一九点提醒我喝水”.',
  },
  invalid_relative_time: {
    'zh-CN': '请用整数分钟或小时表示时长，范围为 1 分钟到 168 小时，也可以说“半小时后提醒我休息”。',
    en: 'Use whole minutes or hours, from 1 minute to 168 hours. Half-hour phrases such as “半小时后提醒我休息” also work.',
  },
  ambiguous_time: {
    'zh-CN': '一句提醒只保留一个时间，请删去多余的时间后再发送。',
    en: 'Keep just one time in each reminder. Remove the extra times, then send it again.',
  },
  relative_recurrence_unsupported: {
    'zh-CN': '重复提醒需要固定钟点，例如“每天九点提醒我喝水”。',
    en: 'Repeating reminders need a fixed clock time. For example, enter “每天九点提醒我喝水”.',
  },
  missing_task: {
    'zh-CN': '还差需要提醒的事情，请补充完整，例如“十分钟后提醒我喝水”。',
    en: 'Add what you want to be reminded about. For example, enter “十分钟后提醒我喝水”.',
  },
  past_time: {
    'zh-CN': '这个时间已经过去了，请改为未来的时间，例如“十分钟后提醒我喝水”。',
    en: 'That time has already passed. Choose a future time, for example “十分钟后提醒我喝水”.',
  },
}

export function getReminderParseFeedback(reason, language = 'zh-CN') {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  return PARSE_FEEDBACK[reason]?.[locale] ?? null
}
