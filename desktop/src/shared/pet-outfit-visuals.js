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
  const item = petType === 'pig' ? PIG_OUTFIT_SPRITES[itemId] : null
  return item ? getSpritePosition(item.column, item.row) : null
}

export function getPetOutfitVisual(petType, itemId, action = 'idle') {
  const item = petType === 'pig' ? PIG_OUTFIT_SPRITES[itemId] : null
  if (!item) {
    return null
  }

  const offset = PIG_ACTION_SLOT_OFFSETS[action]?.[item.slot] || { x: 0, y: 0 }
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
