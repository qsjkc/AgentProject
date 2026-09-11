const personality = {
  cat: {
    createdReminder: (title, time) => `行吧，${time} 我会提醒你：${title}。`,
    reminderDue: (title) => `别装没看见，该做「${title}」了。`,
    parseFailed: '这句话我没听懂时间。说清楚几点，我再记。',
  },
  dog: {
    createdReminder: (title, time) => `收到！${time} 我一定提醒你：${title}！`,
    reminderDue: (title) => `到点啦！我们该处理「${title}」了！`,
    parseFailed: '我想帮你记下来，但还差具体时间。',
  },
  pig: {
    createdReminder: (title, time) => `好哦，${time} 我会慢慢提醒你：${title}。`,
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
