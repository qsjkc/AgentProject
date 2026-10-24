import { getPetWeeklyCompanionCopy } from './pet-weekly-summary.js'


const personality = {
  cat: {
    createdReminder: (title, time, emailEnabled = false, recurrenceLabel = '') => (
      `行吧，${recurrenceLabel ? `${recurrenceLabel}，` : ''}${time} 我会提醒你：${title}。${emailEnabled ? '到点也会发邮件。' : ''}`
    ),
    reminderDue: (title) => `别装没看见，该做「${title}」了。`,
    parseFailed: '这句话我没听懂时间。说清楚几点，我再记。',
  },
  dog: {
    createdReminder: (title, time, emailEnabled = false, recurrenceLabel = '') => (
      `收到！${recurrenceLabel ? `${recurrenceLabel}，` : ''}${time} 我一定提醒你：${title}！${emailEnabled ? '到点也会发邮件！' : ''}`
    ),
    reminderDue: (title) => `到点啦！我们该处理「${title}」了！`,
    parseFailed: '我想帮你记下来，但还差具体时间。',
  },
  pig: {
    createdReminder: (title, time, emailEnabled = false, recurrenceLabel = '') => (
      `好哦，${recurrenceLabel ? `${recurrenceLabel}，` : ''}${time} 我会慢慢提醒你：${title}。${emailEnabled ? '到点也会发邮件给你。' : ''}`
    ),
    reminderDue: (title) => `时间到啦，记得「${title}」。`,
    parseFailed: '我还没抓到具体时间，再说一遍几点吧。',
  },
}

const relationshipEventCopy = {
  cat: {
    wake: {
      'zh-CN': '醒了。你最好真的有事找我。',
      en: 'I am awake. This had better be important.',
    },
    dress_up: {
      'zh-CN': '还行，这套勉强配得上我。',
      en: 'Acceptable. This look almost suits me.',
    },
    level_up: {
      'zh-CN': (level) => `Lv.${level}。看来我可以再信任你一点。`,
      en: (level) => `Lv.${level}. I suppose I can trust you a little more.`,
    },
  },
  dog: {
    wake: {
      'zh-CN': '我醒啦！现在要一起做什么？',
      en: 'I am awake! What are we doing together?',
    },
    dress_up: {
      'zh-CN': '新装扮！快看看我是不是很精神！',
      en: 'A new outfit! Do I look ready to go?',
    },
    level_up: {
      'zh-CN': (level) => `到 Lv.${level} 啦！我们越来越默契了！`,
      en: (level) => `Lv.${level}! We make a better team every day!`,
    },
  },
  pig: {
    wake: {
      'zh-CN': '哼唧，我醒啦。先伸个懒腰。',
      en: 'Oink, I am awake. Let me stretch first.',
    },
    dress_up: {
      'zh-CN': '这身挺合适，容我慢慢转一圈。',
      en: 'This suits me. Let me take one slow turn.',
    },
    level_up: {
      'zh-CN': (level) => `到 Lv.${level} 啦，我们又熟了一点点。`,
      en: (level) => `Lv.${level}. We know each other a little better now.`,
    },
  },
}

const pigRelationshipMilestoneCopy = {
  2: {
    'zh-CN': '到 Lv.2 啦，软绒睡帽也解锁了。先戴给你看看。',
    en: 'Lv.2! I unlocked a soft sleep cap. Let me try it on for you.',
  },
  3: {
    'zh-CN': '到 Lv.3 啦，提醒铃铛也解锁了。先让我试试看。',
    en: 'Lv.3! I unlocked a reminder bell. Let me try it on.',
  },
  4: {
    'zh-CN': '到 Lv.4 啦，搭档工作牌归我了。戴上给你看看。',
    en: 'Lv.4! My partner badge is here. Let me show you how it looks.',
  },
  5: {
    'zh-CN': '到 Lv.5 啦，星星小帽也来了。我们真的很熟了。',
    en: 'Lv.5! The star hat is here. We really do know each other now.',
  },
}

const pigCompanionCopy = {
  'zh-CN': {
    daily_greeting: {
      morning: [
        { id: 'pig-daily-morning-1', text: '早呀，我先伸个懒腰，再陪你慢慢开始。' },
        { id: 'pig-daily-morning-2', text: '新的一天到了，不用一下子把事情都做完。' },
        { id: 'pig-daily-morning-3', text: '你来啦。今天也让我待在顺手的位置吧。', minLevel: 3 },
      ],
      midday: [
        { id: 'pig-daily-midday-1', text: '到中午啦，记得让眼睛和肩膀歇一会儿。' },
        { id: 'pig-daily-midday-2', text: '先喘口气，下午的事可以下午再慢慢做。' },
      ],
      afternoon: [
        { id: 'pig-daily-afternoon-1', text: '下午好，我已经在桌边找好位置啦。' },
        { id: 'pig-daily-afternoon-2', text: '不用赶，我陪你把下午一点点过完。' },
      ],
      evening: [
        { id: 'pig-daily-evening-1', text: '晚上好。忙了一天，节奏可以放慢一点啦。' },
        { id: 'pig-daily-evening-2', text: '你回来就好，剩下的事情我们慢慢收尾。', minLevel: 3 },
      ],
      late_night: [
        { id: 'pig-daily-late-1', text: '夜深啦，我会安静一点陪着你。' },
      ],
    },
    welcome_back: {
      default: [
        { id: 'pig-return-1', text: '你回来啦，我刚才有乖乖待在这里。' },
        { id: 'pig-return-2', text: '哼唧，等到你啦。先坐稳，再继续。' },
        { id: 'pig-return-3', text: '看到你回来，我就放心啦。', minLevel: 3 },
        { id: 'pig-return-4', text: '老搭档回来啦，我给你留着位置呢。', minLevel: 4 },
      ],
    },
    proactive_moment: {
      morning: [
        { id: 'pig-moment-morning-1', text: '先把肩膀放松一下，今天还长着呢。' },
        { id: 'pig-moment-morning-2', text: '我活动一下，你也可以顺便伸伸腰。' },
      ],
      midday: [
        { id: 'pig-moment-midday-1', text: '闻到午饭的方向了吗？我好像闻到了。' },
        { id: 'pig-moment-midday-2', text: '休息几分钟不算偷懒，我可以作证。' },
      ],
      afternoon: [
        { id: 'pig-moment-afternoon-1', text: '我去跑两步醒醒神，你也眨眨眼吧。' },
        { id: 'pig-moment-afternoon-2', text: '下午容易发困，我们换口气再继续。' },
        { id: 'pig-moment-afternoon-3', text: '我还在，今天剩下的路一起慢慢走。', minLevel: 3 },
      ],
      evening: [
        { id: 'pig-moment-evening-1', text: '差不多该收一收啦，别把今天拖得太长。' },
        { id: 'pig-moment-evening-2', text: '忙完这一小段，就让自己歇一会儿吧。' },
      ],
      late_night: [
        { id: 'pig-moment-late-1', text: '我开始打哈欠啦，你也别撑得太晚。' },
      ],
    },
  },
  en: {
    daily_greeting: {
      morning: [
        { id: 'pig-daily-morning-1-en', text: 'Morning. Let me stretch, then we can start slowly.' },
        { id: 'pig-daily-morning-2-en', text: 'A new day. We do not have to finish everything at once.' },
        { id: 'pig-daily-morning-3-en', text: 'You are here. Keep me somewhere close again today.', minLevel: 3 },
      ],
      midday: [
        { id: 'pig-daily-midday-1-en', text: 'It is noon. Give your eyes and shoulders a short break.' },
        { id: 'pig-daily-midday-2-en', text: 'Take a breath. The afternoon can wait for the afternoon.' },
      ],
      afternoon: [
        { id: 'pig-daily-afternoon-1-en', text: 'Good afternoon. I found my place beside you.' },
        { id: 'pig-daily-afternoon-2-en', text: 'No rush. I will stay with you through the afternoon.' },
      ],
      evening: [
        { id: 'pig-daily-evening-1-en', text: 'Good evening. The pace can soften now.' },
        { id: 'pig-daily-evening-2-en', text: 'You are back. We can finish the rest slowly.', minLevel: 3 },
      ],
      late_night: [
        { id: 'pig-daily-late-1-en', text: 'It is late. I will stay quietly beside you.' },
      ],
    },
    welcome_back: {
      default: [
        { id: 'pig-return-1-en', text: 'You are back. I stayed right here.' },
        { id: 'pig-return-2-en', text: 'Oink, there you are. Settle in before we continue.' },
        { id: 'pig-return-3-en', text: 'Seeing you back makes me feel better.', minLevel: 3 },
        { id: 'pig-return-4-en', text: 'My old partner is back. I saved your place.', minLevel: 4 },
      ],
    },
    proactive_moment: {
      morning: [
        { id: 'pig-moment-morning-1-en', text: 'Relax your shoulders. The day is still long.' },
        { id: 'pig-moment-morning-2-en', text: 'I am stretching. You can stretch with me.' },
      ],
      midday: [
        { id: 'pig-moment-midday-1-en', text: 'Can you smell lunch? I think I can.' },
        { id: 'pig-moment-midday-2-en', text: 'A short break is not slacking. I can confirm that.' },
      ],
      afternoon: [
        { id: 'pig-moment-afternoon-1-en', text: 'I will run a little. Give your eyes a blink too.' },
        { id: 'pig-moment-afternoon-2-en', text: 'Afternoons get sleepy. Let us reset and continue.' },
        { id: 'pig-moment-afternoon-3-en', text: 'I am still here. We can finish the day together.', minLevel: 3 },
      ],
      evening: [
        { id: 'pig-moment-evening-1-en', text: 'It may be time to wrap up. Do not stretch today too far.' },
        { id: 'pig-moment-evening-2-en', text: 'Finish this small part, then give yourself a rest.' },
      ],
      late_night: [
        { id: 'pig-moment-late-1-en', text: 'I am yawning. Try not to stay up too late.' },
      ],
    },
  },
}

const PET_TYPES = ['cat', 'dog', 'pig']

function createCompanionCopy(petType, locale, greetings, moments, returns) {
  const times = ['morning', 'midday', 'afternoon', 'evening', 'late_night']
  const byTime = (texts, kind) => Object.fromEntries(times.map((time, index) => [time, [
    { id: `${petType}-${kind}-${time}-${locale}`, text: texts[index] },
  ]]))
  return {
    daily_greeting: byTime(greetings, 'daily'),
    proactive_moment: byTime(moments, 'moment'),
    welcome_back: { default: returns.map((text, index) => ({
      id: `${petType}-return-${index + 1}-${locale}`, text,
      ...(index > 0 ? { minLevel: 3 } : {}),
    })) },
  }
}

const companionCopyByPet = {
  pig: pigCompanionCopy,
  cat: {
    'zh-CN': createCompanionCopy('cat', 'zh-CN', [
      '早。桌边这块位置归我，你慢慢开始。',
      '中午了。眼睛离开屏幕一会儿，我替你看着。',
      '下午好。我已经窝好了，有事叫我。',
      '晚上了，事情可以一件件收尾。我陪着。',
      '夜深了。我会轻一点，你也别太勉强。',
    ], [
      '我伸个懒腰。你也活动一下，别僵着。',
      '该吃饭就去吃饭，我不会把你的位置占满。',
      '先眨眨眼。我巡视一圈，马上回来。',
      '今天已经很努力了，留点时间给自己吧。',
      '哈欠会传染。困了就休息，我明天还在。',
    ], ['回来了？位置给你留着，先坐稳。', '老搭档回来了。嗯，我是有一点想你。']),
    en: createCompanionCopy('cat', 'en', [
      'Morning. This corner is mine. Take your time getting started.',
      'It is noon. Rest your eyes. I will watch the screen for you.',
      'Good afternoon. I have settled in. Call if you need me.',
      'Evening. We can wrap things up one at a time. I am here.',
      'It is late. I will be quiet. Go easy on yourself too.',
    ], [
      'I am stretching. You could loosen up too.',
      'Go have lunch. I promise to leave you some room.',
      'Blink for a moment. I will make a quick patrol.',
      'You worked hard today. Save a little time for yourself.',
      'Yawns are contagious. Rest if you are tired. I will be here tomorrow.',
    ], ['Back? I saved your spot. Settle in.', 'My old partner is back. Yes, I missed you a little.']),
  },
  dog: {
    'zh-CN': createCompanionCopy('dog', 'zh-CN', [
      '早呀！我已经准备好陪你开始新的一天啦！',
      '中午好！先让眼睛和肩膀休息，我陪你歇一会儿！',
      '下午也一起加油！先从一件小事开始吧。',
      '晚上好！忙了一天，接下来我们慢慢收尾！',
      '夜深啦，我会安静守着你。累了就歇一歇。',
    ], [
      '一起伸个懒腰吧！不用着急，我们慢慢来。',
      '午饭时间到！吃饱了才有力气继续陪你。',
      '我跑两步醒醒神！你也让眼睛歇一下吧。',
      '今天辛苦啦！做完这一小段，我们就休息。',
      '我也打哈欠啦。明天还会陪着你，放心休息吧。',
    ], ['你回来啦！我一直给你留着位置呢！', '搭档回来啦！尾巴都开心得停不下来了！']),
    en: createCompanionCopy('dog', 'en', [
      'Morning! I am ready to start a new day with you!',
      'Hello, noon! Rest your eyes and shoulders. I will take a break with you!',
      'Let us do this afternoon together! One small thing at a time.',
      'Good evening! A busy day. Let us wrap it up gently!',
      'It is late. I will stay quietly beside you. Rest if you need to.',
    ], [
      'Let us stretch! No rush. We can take our time.',
      'Lunch time! We need fuel for the rest of our day.',
      'I will jog a little! Give your eyes a break too.',
      'You did well today! Finish this little stretch, then rest.',
      'I am yawning too. I will be here tomorrow. You can rest.',
    ], ['You are back! I saved your place!', 'My partner is back! My tail cannot stop wagging!']),
  },
}

const milestoneCopyByPet = {
  pig: pigRelationshipMilestoneCopy,
  cat: {
    2: { 'zh-CN': 'Lv.2，睡帽收下了。能让我安心打盹的人可不多。', en: 'Lv.2. A sleep cap. I do not nap this comfortably around everyone.' },
    3: { 'zh-CN': 'Lv.3，铃铛也有了。以后重要的事，我会替你惦记。', en: 'Lv.3. A bell. I will keep an eye on the things that matter to you.' },
    4: { 'zh-CN': 'Lv.4，这块搭档工作牌我认了。我们确实挺默契。', en: 'Lv.4. I accept this partner badge. We do make a good team.' },
    5: { 'zh-CN': 'Lv.5，星星小帽很合适。你已经是我认定的自己人了。', en: 'Lv.5. The star hat suits me. You are officially one of my people.' },
  },
  dog: {
    2: { 'zh-CN': 'Lv.2 啦！睡帽戴好，有你在我就安心！', en: 'Lv.2! Sleep cap on. I feel safe with you around!' },
    3: { 'zh-CN': 'Lv.3 啦！铃铛也准备好了，重要的事我们一起记住！', en: 'Lv.3! Bell ready. We will remember the important things together!' },
    4: { 'zh-CN': 'Lv.4！搭档工作牌戴好啦，下一段路也一起走！', en: 'Lv.4! Partner badge on. Let us keep going together!' },
    5: { 'zh-CN': 'Lv.5 啦！戴上星星小帽，我最好的搭档就是你！', en: 'Lv.5! Star hat on. You are my very best partner!' },
  },
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function getPetDailyMemoryCopy(petType, language, event, summary, recentCopyIds) {
  if (
    !summary
    || (summary.pet_type && summary.pet_type !== petType)
    || !event?.type
    || (
      summary.interaction_count <= 0
      && summary.reminders_created_count <= 0
      && summary.reminders_completed_count <= 0
    )
  ) {
    return null
  }

  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const dateKey = summary.local_date || 'today'
  const candidates = []
  if (summary.reminders_completed_count > 0) {
    candidates.push({
      id: `${petType}-memory-reminders-${locale}-${dateKey}`,
      text: locale === 'zh-CN'
        ? `今天已经一起完成 ${summary.reminders_completed_count} 个提醒啦，我都记得。`
        : `We finished ${formatCount(summary.reminders_completed_count, 'reminder')} today. I remember.`,
    })
  }
  if (summary.care_count > 0) {
    candidates.push({
      id: `${petType}-memory-care-${locale}-${dateKey}`,
      text: locale === 'zh-CN'
        ? `今天你照顾了我 ${summary.care_count} 次，我有认真记着。`
        : `You cared for me ${summary.care_count} time${summary.care_count === 1 ? '' : 's'} today. I remember.`,
    })
  }
  if (summary.meaningful_chat_count > 0) {
    candidates.push({
      id: `${petType}-memory-chat-${locale}-${dateKey}`,
      text: locale === 'zh-CN'
        ? `今天我们认真聊了 ${summary.meaningful_chat_count} 次，我还记得。`
        : `We had ${formatCount(summary.meaningful_chat_count, 'real chat')} today. I remember.`,
    })
  }
  candidates.push({
    id: `${petType}-memory-together-${locale}-${dateKey}`,
    text: locale === 'zh-CN'
      ? `今天已经有 ${summary.interaction_count} 次认真相处啦。`
      : `We have shared ${formatCount(summary.interaction_count, 'meaningful moment')} today.`,
  })

  const recent = new Set(recentCopyIds)
  const selected = candidates.find((item) => !recent.has(item.id)) || null
  if (!selected || petType === 'pig') return selected
  const ending = locale === 'zh-CN'
    ? petType === 'cat' ? '别看我安静，我都放在心上。' : '能和你一起，我的尾巴又开心起来啦！'
    : petType === 'cat' ? ' I may be quiet, but I notice.' : ' Sharing it with you makes my tail wag!'
  return { ...selected, text: `${selected.text}${ending}` }
}

export function getPetReminderCopy(petType) {
  return personality[petType] || personality.cat
}

export function getPetRelationshipEventCopy(
  petType,
  language,
  event,
  relationship = null,
) {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const animalCopy = relationshipEventCopy[petType] || relationshipEventCopy.cat
  const value = animalCopy[event]?.[locale]
  if (typeof value === 'function') {
    return value(relationship?.level || 1)
  }
  return value || ''
}

export function getPetRelationshipMilestoneCopy(petType, language, milestone) {
  if (!PET_TYPES.includes(petType)) return ''
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  return milestoneCopyByPet[petType][Number(milestone?.level)]?.[locale]
    || getPetRelationshipEventCopy(petType, language, 'level_up', milestone)
}

export function getPetCompanionCopy(
  petType,
  language,
  event,
  relationship = null,
  recentCopyIds = [],
  dailySummary = null,
  weeklySummary = null,
) {
  if (!PET_TYPES.includes(petType) || !event?.type || (relationship?.pet_type && relationship.pet_type !== petType)) {
    return null
  }

  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const weeklyCopy = weeklySummary?.pet_type === petType
    ? getPetWeeklyCompanionCopy(locale, weeklySummary)
    : null
  if (weeklyCopy && !recentCopyIds.includes(weeklyCopy.id)) {
    return weeklyCopy
  }
  const memoryCopy = getPetDailyMemoryCopy(petType, locale, event, dailySummary, recentCopyIds)
  if (memoryCopy) {
    return memoryCopy
  }
  const eventCopy = companionCopyByPet[petType][locale]?.[event.type]
  const pool = eventCopy?.[event.timeContext] || eventCopy?.default || []
  const level = Math.max(1, Number(relationship?.level) || 1)
  const eligible = pool.filter((item) => !item.minLevel || level >= item.minLevel)
  if (!eligible.length) {
    return null
  }

  const recent = new Set(recentCopyIds)
  const unused = eligible.filter((item) => !recent.has(item.id))
  const candidates = unused.length ? unused : eligible
  const index = (recentCopyIds.length + level) % candidates.length
  return candidates[index]
}
