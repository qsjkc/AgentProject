export const PET_OUTFIT_SLOTS = ['head', 'neck', 'side', 'scene']

const PET_OUTFIT_CATALOG = {
  pig: [
    {
      id: 'pig_basic_scarf',
      slot: 'neck',
      unlockLevel: 1,
      labels: {
        'zh-CN': '基础小围巾',
        en: 'Everyday scarf',
      },
    },
    {
      id: 'pig_sleep_cap',
      slot: 'head',
      unlockLevel: 2,
      labels: {
        'zh-CN': '软绵睡帽',
        en: 'Sleep cap',
      },
    },
    {
      id: 'pig_bell',
      slot: 'side',
      unlockLevel: 3,
      labels: {
        'zh-CN': '提醒铃铛',
        en: 'Reminder bell',
      },
    },
    {
      id: 'pig_work_badge',
      slot: 'side',
      unlockLevel: 4,
      labels: {
        'zh-CN': '搭档工作牌',
        en: 'Partner badge',
      },
    },
    {
      id: 'pig_star_hat',
      slot: 'head',
      unlockLevel: 5,
      labels: {
        'zh-CN': '星星小帽',
        en: 'Star hat',
      },
    },
  ],
  cat: [],
  dog: [],
}

const SLOT_LABELS = {
  head: {
    'zh-CN': '头部',
    en: 'Head',
  },
  neck: {
    'zh-CN': '颈部',
    en: 'Neck',
  },
  side: {
    'zh-CN': '侧边道具',
    en: 'Side prop',
  },
  scene: {
    'zh-CN': '场景道具',
    en: 'Scene prop',
  },
}

function getLocale(language) {
  return language === 'zh-CN' ? 'zh-CN' : 'en'
}

export function getPetOutfitCatalog(petType, language = 'zh-CN') {
  const locale = getLocale(language)
  return (PET_OUTFIT_CATALOG[petType] || []).map((item) => ({
    ...item,
    label: item.labels[locale],
  }))
}

export function getPetOutfitItem(petType, itemId, language = 'zh-CN') {
  return getPetOutfitCatalog(petType, language).find((item) => item.id === itemId) || null
}

export function getPetOutfitSlotLabel(slot, language = 'zh-CN') {
  const labels = SLOT_LABELS[slot] || SLOT_LABELS.scene
  return labels[getLocale(language)]
}

export function getUnlockedPetOutfitIds(petType, level) {
  return getPetOutfitCatalog(petType)
    .filter((item) => item.unlockLevel <= level)
    .map((item) => item.id)
}

export function normalizePetOutfitState(value, petType, level) {
  const catalog = getPetOutfitCatalog(petType)
  const knownItems = new Map(catalog.map((item) => [item.id, item]))
  const unlockedIds = new Set(
    Array.isArray(value?.unlocked_outfit_ids)
      ? value.unlocked_outfit_ids.filter((itemId) => knownItems.has(itemId))
      : [],
  )
  getUnlockedPetOutfitIds(petType, level).forEach((itemId) => unlockedIds.add(itemId))

  const equippedOutfits = {}
  for (const [slot, itemId] of Object.entries(value?.equipped_outfits || {})) {
    const item = knownItems.get(itemId)
    if (
      PET_OUTFIT_SLOTS.includes(slot)
      && item?.slot === slot
      && unlockedIds.has(itemId)
    ) {
      equippedOutfits[slot] = itemId
    }
  }

  return {
    unlocked_outfit_ids: catalog
      .filter((item) => unlockedIds.has(item.id))
      .map((item) => item.id),
    equipped_outfits: equippedOutfits,
  }
}

export function applyPetOutfitPreview(outfit, petType, itemId) {
  const item = getPetOutfitItem(petType, itemId)
  const unlockedIds = Array.isArray(outfit?.unlocked_outfit_ids)
    ? [...outfit.unlocked_outfit_ids]
    : []
  const equippedOutfits = { ...(outfit?.equipped_outfits || {}) }

  if (!item || !unlockedIds.includes(item.id)) {
    return {
      unlocked_outfit_ids: unlockedIds,
      equipped_outfits: equippedOutfits,
    }
  }

  return {
    unlocked_outfit_ids: unlockedIds,
    equipped_outfits: {
      ...equippedOutfits,
      [item.slot]: item.id,
    },
  }
}
