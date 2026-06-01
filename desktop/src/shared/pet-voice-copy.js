const COPY = {
  'zh-CN': {
    cat: {
      voiceArmed: '按住 D 说话，松开结束。',
      connecting: '正在连接语音……稍等一下。',
      ready: '按住 D 开始说话。',
      listening: '我在听，松开 D 结束。',
      processing: '收到，我想一下。',
      replyingPrefix: '这是我刚刚听到的回复：',
      subtitleUnavailable: '暂时无法识别 AI 回复字幕，请再试一次。',
      voiceDisabled: '你已经在桌面端关闭了语音模式。',
      openQuickChatHint: '语音不可用时，可以去主面板或托盘打开文字聊天。',
    },
    dog: {
      voiceArmed: '按住 D 说话，松开我就开始回应你。',
      connecting: '我先把语音接通，很快就好。',
      ready: '准备好了，按住 D 直接说。',
      listening: '我在认真听，松开 D 就行。',
      processing: '收到，我马上整理一下。',
      replyingPrefix: '我整理好的回答在这里：',
      subtitleUnavailable: '我收到了语音，但这轮字幕没认出来，再试一次。',
      voiceDisabled: '你已经把桌面端语音入口关掉了。',
      openQuickChatHint: '如果想改用文字，我还能从托盘或主面板继续陪你聊。',
    },
    pig: {
      voiceArmed: '按住 D 说话吧，松开我再慢慢回答你。',
      connecting: '我先把语音连上，别急。',
      ready: '好了，按住 D 慢慢说。',
      listening: '我在听呢，松开 D 就结束。',
      processing: '我想一想，马上回来。',
      replyingPrefix: '我这边听到的回复是：',
      subtitleUnavailable: '这轮字幕有点乱，我先不乱猜，你再试一次。',
      voiceDisabled: '桌面端语音已经被你关掉了。',
      openQuickChatHint: '不走语音也没关系，你还可以去主面板或托盘打开文字聊天。',
    },
  },
  en: {
    cat: {
      voiceArmed: 'Hold D to talk. Release it to finish.',
      connecting: 'Connecting voice now...',
      ready: 'Ready. Hold D to speak.',
      listening: 'I am listening. Release D to finish.',
      processing: 'Got it. Let me think.',
      replyingPrefix: 'Here is the reply I picked up:',
      subtitleUnavailable: 'I could not identify the AI subtitle this round. Try again.',
      voiceDisabled: 'Desktop voice mode is disabled.',
      openQuickChatHint: 'If voice is unavailable, open quick chat from the tray or main panel.',
    },
    dog: {
      voiceArmed: 'Hold D to talk. I will answer when you let go.',
      connecting: 'Connecting voice...',
      ready: 'Ready. Hold D and speak.',
      listening: 'I am listening. Release D when you are done.',
      processing: 'Got it. Let me work through that.',
      replyingPrefix: 'Here is the reply I heard:',
      subtitleUnavailable: 'I heard the voice round, but the subtitle did not land. Try again.',
      voiceDisabled: 'Desktop voice mode is disabled.',
      openQuickChatHint: 'You can still use text chat from the tray or main panel.',
    },
    pig: {
      voiceArmed: 'Hold D to talk. Release it and I will answer gently.',
      connecting: 'Connecting voice now...',
      ready: 'Ready. Hold D and speak.',
      listening: 'I am listening. Release D to finish.',
      processing: 'Let me think about that for a second.',
      replyingPrefix: 'This is the reply I picked up:',
      subtitleUnavailable: 'The subtitle could not be trusted this round. Please try again.',
      voiceDisabled: 'Desktop voice mode is disabled.',
      openQuickChatHint: 'You can still switch to text chat from the tray or main panel.',
    },
  },
}

function normalizeLanguage(language) {
  return String(language || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

function normalizePetType(petType) {
  const normalized = String(petType || 'cat').toLowerCase()
  if (normalized === 'dog' || normalized === 'pig') {
    return normalized
  }
  return 'cat'
}

export function getPetVoiceCopy(language, petType, key) {
  const nextLanguage = normalizeLanguage(language)
  const nextPetType = normalizePetType(petType)
  return COPY[nextLanguage]?.[nextPetType]?.[key] ?? COPY['zh-CN'].cat[key] ?? key
}
