import { normalizePetOutfitState } from './pet-outfits.js'

export const RELATIONSHIP_STAGES = {
  new_friend: {
    'zh-CN': '刚认识',
    en: 'New friends',
  },
  getting_familiar: {
    'zh-CN': '有点熟',
    en: 'Getting familiar',
  },
  clingy: {
    'zh-CN': '会黏人',
    en: 'Growing attached',
  },
  trusted_partner: {
    'zh-CN': '老搭档',
    en: 'Trusted partners',
  },
  deep_bond: {
    'zh-CN': '特别信任你',
    en: 'Deeply bonded',
  },
}

function toNonNegativeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function normalizePetRelationship(value, fallbackPetType = 'cat') {
  if (!value || typeof value !== 'object') {
    return null
  }

  const progress = value.progress || {}
  const required = toNonNegativeNumber(progress.required)
  const current = Math.min(toNonNegativeNumber(progress.current), required || Number.MAX_SAFE_INTEGER)
  const percent = required === 0
    ? 100
    : Math.min(100, toNonNegativeNumber(progress.percent, (current / required) * 100))
  const level = Math.min(5, Math.max(1, Math.trunc(toNonNegativeNumber(value.level, 1))))
  const petType = value.pet_type || value.petType || fallbackPetType

  return {
    ...value,
    pet_type: petType,
    intimacy_xp: toNonNegativeNumber(value.intimacy_xp),
    level,
    relationship_stage: RELATIONSHIP_STAGES[value.relationship_stage]
      ? value.relationship_stage
      : 'new_friend',
    current_mood: value.current_mood || 'idle',
    outfit: normalizePetOutfitState(value.outfit, petType, level),
    progress: {
      current,
      required,
      percent,
    },
  }
}

export function getRelationshipStageLabel(language, stage) {
  const labels = RELATIONSHIP_STAGES[stage] || RELATIONSHIP_STAGES.new_friend
  return labels[language] || labels.en
}

export function createRewardIdempotencyKey(petType, action) {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `pet:${petType}:${action}:${randomPart}`
}
