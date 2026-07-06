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

export function getPetReminderCopy(petType) {
  return personality[petType] || personality.cat
}
