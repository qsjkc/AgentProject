const CARE_ACTION_DEFINITIONS = [
  {
    id: 'pat',
    animationEvent: 'PET_PAT',
    rewardAction: 'pat',
  },
  {
    id: 'feed',
    animationEvent: 'PET_FEED',
    rewardAction: 'feed',
  },
  {
    id: 'clean',
    animationEvent: 'PET_CLEAN',
    rewardAction: 'clean',
  },
]

const LABELS = {
  pat: {
    'zh-CN': '摸摸',
    en: 'Pat',
  },
  feed: {
    'zh-CN': '喂零食',
    en: 'Feed',
  },
  clean: {
    'zh-CN': '清洁',
    en: 'Clean',
  },
}

const PIG_MESSAGES = {
  pat: {
    'zh-CN': '哼哼，再摸两下也不是不行。',
    en: 'A little more patting would be acceptable.',
  },
  feed: {
    'zh-CN': '闻到了！这块小饼干归我啦。',
    en: 'I smelled that cookie. It is mine now.',
  },
  clean: {
    'zh-CN': '洗香香了，今天也是体面小猪。',
    en: 'Fresh and tidy. A very presentable pig today.',
  },
}

function getLocale(language) {
  return language === 'zh-CN' ? 'zh-CN' : 'en'
}

export function getPetCareActions(language, petType) {
  if (petType !== 'pig') {
    return []
  }

  const locale = getLocale(language)
  return CARE_ACTION_DEFINITIONS.map((definition) => ({
    ...definition,
    label: LABELS[definition.id][locale],
    message: PIG_MESSAGES[definition.id][locale],
  }))
}

export function getPetCareToolbarLabel(language) {
  return getLocale(language) === 'zh-CN' ? '照顾小猪' : 'Care for pig'
}
