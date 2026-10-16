import { isPetRelationshipForAccountContext } from './pet-account-context.js'

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

const PET_MESSAGES = {
  pig: PIG_MESSAGES,
  cat: {
    pat: { 'zh-CN': '喵，手法不错。再摸一下也可以。', en: 'Mrr. Good technique. You may pat me again.' },
    feed: { 'zh-CN': '这块点心我收下了。算你记得我的口味。', en: 'I accept this treat. You remembered what I like.' },
    clean: { 'zh-CN': '毛毛整理好了，现在可以继续优雅地陪你。', en: 'Fur in order. I can keep you company in style.' },
  },
  dog: {
    pat: { 'zh-CN': '汪！被你摸摸，尾巴都停不下来啦！', en: 'Woof! A pat from you makes my tail go wild!' },
    feed: { 'zh-CN': '好香！谢谢你，下一小段也一起加油！', en: 'Yum! Thank you! Let us tackle the next little stretch together!' },
    clean: { 'zh-CN': '洗干净啦！精神满满，继续陪着你！', en: 'All clean! Fresh and ready to stay by your side!' },
  },
}

function getLocale(language) {
  return language === 'zh-CN' ? 'zh-CN' : 'en'
}

export function isPetCareContextReady({ hasSession, userId, petType, relationship, onboardingLoaded }) {
  // Guest interactions remain local. Signed-in care must wait until the same
  // relationship can also record the interaction in its onboarding state.
  if (!hasSession) return true
  const relationshipId = Number(relationship?.id)
  return Boolean(
    onboardingLoaded
    && Number.isInteger(relationshipId)
    && relationshipId > 0
    && isPetRelationshipForAccountContext(relationship, { hasSession, userId, petType })
  )
}

export function getPetCareActions(language, petType) {
  if (!Object.hasOwn(PET_MESSAGES, petType)) {
    return []
  }

  const locale = getLocale(language)
  return CARE_ACTION_DEFINITIONS.map((definition) => ({
    ...definition,
    label: LABELS[definition.id][locale],
    message: PET_MESSAGES[petType][definition.id][locale],
  }))
}

export function getPetCareToolbarLabel(language, petType = 'pig') {
  const names = { cat: '小猫', dog: '小狗', pig: '小猪' }
  return getLocale(language) === 'zh-CN'
    ? `照顾${names[petType] || '宠物'}`
    : `Care for ${Object.hasOwn(names, petType) ? petType : 'pet'}`
}
