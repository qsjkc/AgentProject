import pigOutfitSprite from '../../../frontend/src/assets/pets/pig/outfits/sprite.png'

const PIG_OUTFIT_SPRITES = {
  pig_basic_scarf: {
    column: 0,
    row: 0,
    slot: 'neck',
    anchor: { left: 27, top: 48, width: 50, height: 50, zIndex: 2 },
  },
  pig_sleep_cap: {
    column: 1,
    row: 0,
    slot: 'head',
    anchor: { left: 43, top: 5, width: 52, height: 52, zIndex: 3 },
  },
  pig_bell: {
    column: 2,
    row: 0,
    slot: 'side',
    anchor: { left: 98, top: 48, width: 38, height: 38, zIndex: 2 },
  },
  pig_work_badge: {
    column: 0,
    row: 1,
    slot: 'side',
    anchor: { left: 55, top: 64, width: 54, height: 54, zIndex: 2 },
  },
  pig_star_hat: {
    column: 1,
    row: 1,
    slot: 'head',
    anchor: { left: 34, top: -5, width: 70, height: 70, zIndex: 3 },
  },
}

const PIG_ACTION_SLOT_OFFSETS = {
  sleeping: {
    head: { x: 3, y: 5 },
  },
  reminding: {
    side: { x: -4, y: -5 },
  },
  yawn: {
    head: { x: 3, y: 5 },
  },
}

// Anchors are measured against the independent frames in the 126px pet canvas.
const COMPANION_OUTFIT_ANCHORS = {
  cat: {
    basic_scarf: { left: 29, top: 74, width: 55, height: 55 },
    sleep_cap: { left: 32, top: 10, width: 55, height: 55 },
    bell: { left: 95, top: 77, width: 33, height: 33 },
    work_badge: { left: 41, top: 90, width: 34, height: 34 },
    star_hat: { left: 29, top: 14, width: 61, height: 61 },
  },
  dog: {
    basic_scarf: { left: 41, top: 74, width: 43, height: 43 },
    sleep_cap: { left: 42, top: 14, width: 44, height: 44 },
    bell: { left: 96, top: 81, width: 30, height: 30 },
    work_badge: { left: 54, top: 81, width: 30, height: 30 },
    star_hat: { left: 37, top: 18, width: 49, height: 49 },
  },
}

const COMPANION_CELEBRATION_ANCHORS = {
  cat: {
    basic_scarf: { left: 34, top: 66, width: 55, height: 55 },
    sleep_cap: { left: 38, top: 9, width: 55, height: 55 },
    work_badge: { left: 46, top: 82, width: 34, height: 34 },
    star_hat: { left: 34, top: 12, width: 61, height: 61 },
  },
  dog: {
    basic_scarf: { left: 41, top: 74, width: 43, height: 43 },
    sleep_cap: { left: 42, top: 14, width: 44, height: 44 },
    work_badge: { left: 54, top: 81, width: 30, height: 30 },
    star_hat: { left: 37, top: 18, width: 49, height: 49 },
  },
}

function getOutfitSprite(petType, itemId, action = 'idle') {
  if (!['pig', 'cat', 'dog'].includes(petType)
    || typeof itemId !== 'string'
    || !itemId.startsWith(`${petType}_`)) return null
  const suffix = itemId.slice(petType.length + 1)
  const item = PIG_OUTFIT_SPRITES[`pig_${suffix}`]
  if (!item || petType === 'pig') return item || null
  const celebrating = action === 'welcome_back' || action === 'level_up'
  const sleeping = action === 'sleeping' || action === 'yawn'
  const sleepAnchor = suffix === 'sleep_cap' && sleeping
    ? (petType === 'cat' ? { left: 16, top: 47, width: 55, height: 55 } : { left: 12, top: 64, width: 44, height: 44 })
    : null
  const anchor = sleepAnchor || (celebrating && COMPANION_CELEBRATION_ANCHORS[petType]?.[suffix])
    || COMPANION_OUTFIT_ANCHORS[petType]?.[suffix]
  return anchor ? { ...item, anchor: { ...item.anchor, ...anchor } } : null
}

function getSpritePosition(column, row) {
  return {
    backgroundImage: `url(${pigOutfitSprite})`,
    backgroundPosition: `${(column / 2) * 100}% ${row * 100}%`,
    backgroundSize: '300% 200%',
    backgroundRepeat: 'no-repeat',
  }
}

export function getPetOutfitSpriteStyle(petType, itemId) {
  const item = getOutfitSprite(petType, itemId)
  return item ? getSpritePosition(item.column, item.row) : null
}

export function getPetOutfitVisual(petType, itemId, action = 'idle') {
  const item = getOutfitSprite(petType, itemId, action)
  if (!item) {
    return null
  }

  const offset = (petType === 'pig' && PIG_ACTION_SLOT_OFFSETS[action]?.[item.slot]) || { x: 0, y: 0 }
  return {
    style: {
      ...getSpritePosition(item.column, item.row),
      left: item.anchor.left + offset.x,
      top: item.anchor.top + offset.y,
      width: item.anchor.width,
      height: item.anchor.height,
      zIndex: item.anchor.zIndex,
    },
  }
}
