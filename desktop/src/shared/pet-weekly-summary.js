const WEEKLY_SUMMARY_ACTIONS = [
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

export function normalizePetWeeklySummary(value, petType = 'pig') {
  if (!value || typeof value !== 'object') {
    return null
  }

  const rawActionCounts = value.action_counts && typeof value.action_counts === 'object'
    ? value.action_counts
    : {}
  const actionCounts = Object.fromEntries(
    WEEKLY_SUMMARY_ACTIONS
      .map((action) => [action, toCount(rawActionCounts[action])])
      .filter(([, count]) => count > 0),
  )

  return {
    pet_type: value.pet_type || petType,
    review_key: typeof value.review_key === 'string' ? value.review_key : '',
    week_start: typeof value.week_start === 'string' ? value.week_start : '',
    week_end: typeof value.week_end === 'string' ? value.week_end : '',
    timezone: typeof value.timezone === 'string' ? value.timezone : '',
    eligible: Boolean(value.eligible),
    is_new: Boolean(value.eligible && value.is_new),
    reviewed_at: value.reviewed_at || null,
    active_days: Math.min(7, toCount(value.active_days)),
    interaction_count: toCount(value.interaction_count),
    xp_gained: toCount(value.xp_gained),
    action_counts: actionCounts,
    care_count: toCount(value.care_count),
    meaningful_chat_count: toCount(value.meaningful_chat_count),
    reminders_created_count: toCount(value.reminders_created_count),
    reminders_completed_count: toCount(value.reminders_completed_count),
    level_at_start: Math.max(1, Math.min(5, toCount(value.level_at_start) || 1)),
    level_at_end: Math.max(1, Math.min(5, toCount(value.level_at_end) || 1)),
    levels_gained: Math.min(4, toCount(value.levels_gained)),
    relationship_stage_at_end: value.relationship_stage_at_end || 'new_friend',
    first_interaction_at: value.first_interaction_at || null,
    last_interaction_at: value.last_interaction_at || null,
  }
}

export function getPetWeeklySummaryMessage(language, summary) {
  const zh = language === 'zh-CN'
  if (!summary?.eligible) {
    return ''
  }
  if (summary.levels_gained > 0) {
    return zh
      ? `上周我们从 Lv.${summary.level_at_start} 走到 Lv.${summary.level_at_end}，这段路我收好啦。`
      : `Last week we went from Lv.${summary.level_at_start} to Lv.${summary.level_at_end}. I saved that memory.`
  }
  if (summary.reminders_completed_count > 0) {
    return zh
      ? `上周我们一起完成了 ${summary.reminders_completed_count} 个提醒，我都记得。`
      : `We finished ${formatCount(summary.reminders_completed_count, 'reminder')} last week. I remember.`
  }
  if (summary.care_count > 0) {
    return zh
      ? `上周你照顾了我 ${summary.care_count} 次，我有认真记着。`
      : `You cared for me ${summary.care_count} time${summary.care_count === 1 ? '' : 's'} last week. I remember.`
  }
  if (summary.meaningful_chat_count > 0) {
    return zh
      ? `上周我们认真聊了 ${summary.meaningful_chat_count} 次，这些陪伴我还记得。`
      : `We had ${formatCount(summary.meaningful_chat_count, 'real chat')} last week. I remember the company.`
  }
  return zh
    ? `上周我们有 ${summary.interaction_count} 次认真相处，我把它们放进小本子啦。`
    : `We shared ${formatCount(summary.interaction_count, 'meaningful moment')} last week. I saved them in my little notebook.`
}

export function getPetWeeklySummaryHighlights(language, summary) {
  if (!summary?.eligible) {
    return []
  }
  const zh = language === 'zh-CN'
  return [
    summary.active_days > 0
      ? zh ? `有记录 ${summary.active_days} 天` : `${summary.active_days} recorded days`
      : '',
    summary.care_count > 0
      ? zh ? `照料 ${summary.care_count}` : `Care ${summary.care_count}`
      : '',
    summary.meaningful_chat_count > 0
      ? zh ? `聊天 ${summary.meaningful_chat_count}` : `Chats ${summary.meaningful_chat_count}`
      : '',
  ].filter(Boolean)
}

export function getPetWeeklyCompanionCopy(language, summary) {
  if (!summary?.eligible || !summary.is_new || !summary.review_key) {
    return null
  }
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  return {
    id: `pig-weekly-review-${locale}-${summary.review_key}`,
    text: getPetWeeklySummaryMessage(language, summary),
    weeklyReviewKey: summary.review_key,
  }
}
