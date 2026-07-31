const DAILY_SUMMARY_ACTIONS = [
  'daily_first_wake',
  'poke',
  'drag_release',
  'pat',
  'feed',
  'clean',
  'dress_up',
  'reminder_created',
  'reminder_completed',
  'meaningful_chat',
]

function toCount(value) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function normalizePetDailySummary(value, petType = 'pig') {
  if (!value || typeof value !== 'object') {
    return null
  }

  const rawActionCounts = value.action_counts && typeof value.action_counts === 'object'
    ? value.action_counts
    : {}
  const actionCounts = Object.fromEntries(
    DAILY_SUMMARY_ACTIONS
      .map((action) => [action, toCount(rawActionCounts[action])])
      .filter(([, count]) => count > 0),
  )

  return {
    pet_type: value.pet_type || petType,
    local_date: typeof value.local_date === 'string' ? value.local_date : '',
    timezone: typeof value.timezone === 'string' ? value.timezone : '',
    interaction_count: toCount(value.interaction_count),
    xp_gained: toCount(value.xp_gained),
    action_counts: actionCounts,
    care_count: toCount(value.care_count),
    meaningful_chat_count: toCount(value.meaningful_chat_count),
    reminders_created_count: toCount(value.reminders_created_count),
    reminders_completed_count: toCount(value.reminders_completed_count),
    first_interaction_at: value.first_interaction_at || null,
    last_interaction_at: value.last_interaction_at || null,
  }
}

export function getPetDailySummaryHighlights(language, summary) {
  if (!summary) {
    return []
  }

  const zh = language === 'zh-CN'
  return [
    summary.care_count > 0
      ? zh ? `照料 ${summary.care_count}` : `Care ${summary.care_count}`
      : '',
    summary.meaningful_chat_count > 0
      ? zh ? `聊天 ${summary.meaningful_chat_count}` : `Chats ${summary.meaningful_chat_count}`
      : '',
    summary.reminders_created_count > 0
      ? zh ? `记下提醒 ${summary.reminders_created_count}` : `Reminders set ${summary.reminders_created_count}`
      : '',
  ].filter(Boolean)
}

export function getPetDailySummaryMessage(language, summary) {
  const zh = language === 'zh-CN'
  if (!summary) {
    return zh
      ? '今天还没有新的相处记录，我会在这里等你。'
      : 'Nothing new together yet today. I will be right here.'
  }
  if (summary.reminders_completed_count > 0) {
    return zh
      ? `今天已经一起完成 ${summary.reminders_completed_count} 个提醒啦，我都记得。`
      : `We finished ${formatCount(summary.reminders_completed_count, 'reminder')} today. I remember.`
  }
  if (summary.care_count > 0) {
    return zh
      ? `今天你照顾了我 ${summary.care_count} 次，我有认真记着。`
      : `You cared for me ${summary.care_count} time${summary.care_count === 1 ? '' : 's'} today. I remember.`
  }
  if (summary.meaningful_chat_count > 0) {
    return zh
      ? `今天我们认真聊了 ${summary.meaningful_chat_count} 次，我还记得。`
      : `We had ${formatCount(summary.meaningful_chat_count, 'real chat')} today. I remember.`
  }
  if (summary.interaction_count === 0) {
    return zh
      ? '今天还没有新的相处记录，我会在这里等你。'
      : 'Nothing new together yet today. I will be right here.'
  }
  return zh
    ? `今天已经有 ${summary.interaction_count} 次认真相处啦。`
    : `We have shared ${formatCount(summary.interaction_count, 'meaningful moment')} today.`
}
