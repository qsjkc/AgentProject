import { applyPetOutfitPreview, getPetOutfitItem } from './pet-outfits.js'

export const DRESSED_ACTIONS = [
  'idle', 'walk', 'jump', 'happy', 'confused',
  'reminding', 'sleeping', 'pat', 'eat', 'clean',
]

export const DRESSED_OUTFIT_KEYS = ['none', 'scarf'].flatMap((neck) => (
  ['none', 'sleep_cap', 'star_hat'].flatMap((head) => (
    ['none', 'bell', 'work_badge'].map((side) => `${neck}__${head}__${side}`)
  ))
)).filter((key) => key !== 'none__none__none')

const ALIASES = {
  wake: 'happy', poke: 'jump', drag: 'walk', dress_up: 'idle',
  run: 'walk', stretch: 'idle', look_around: 'confused', yawn: 'sleeping',
  welcome_back: 'happy', level_up: 'happy',
}
const DURATIONS = { run: 72, stretch: 145, look_around: 165, yawn: 175, welcome_back: 92, level_up: 92 }

export function getDressedOutfitKey(petType, action, outfit, previewItemId = null) {
  if (!['pig', 'cat', 'dog'].includes(petType)) return null
  const effective = applyPetOutfitPreview(outfit, petType, previewItemId)
  const unlocked = new Set(effective.unlocked_outfit_ids)
  const equipped = {}
  for (const slot of ['neck', 'head', 'side']) {
    const itemId = effective.equipped_outfits[slot]
    const item = getPetOutfitItem(petType, itemId)
    if (item?.slot === slot && unlocked.has(itemId)) {
      equipped[slot] = itemId.slice(petType.length + 1).replace('basic_scarf', 'scarf')
    }
  }
  // Keep the existing automatic sleep/reminder costumes, while retaining every
  // explicitly equipped slot instead of removing the rest of the wardrobe.
  if (action === 'sleeping' && !equipped.head && unlocked.has(`${petType}_sleep_cap`)) {
    equipped.head = 'sleep_cap'
  }
  if (action === 'reminding' && !equipped.side && unlocked.has(`${petType}_bell`)) {
    equipped.side = 'bell'
  }
  const key = ['neck', 'head', 'side'].map((slot) => equipped[slot] || 'none').join('__')
  return key === 'none__none__none' ? null : key
}

export function createDressedAnimation(sprite, action, outfitKey) {
  const sourceAction = ALIASES[action] || action
  const start = Math.max(0, DRESSED_ACTIONS.indexOf(sourceAction)) * 3
  // Each action has three separately drawn poses. Hold/return frames preserve
  // the original event duration without presenting interpolation as new art.
  let frameIndices = [0, 0, 1, 2, 2, 1].map((index) => start + index)
  if (action === 'run' || action === 'stretch') frameIndices = [0, 1, 2, 1, 0, 1, 2, 1].map((index) => start + index)
  if (action === 'welcome_back') frameIndices.push(start)
  if (action === 'level_up') frameIndices = [9, 10, 6, 6, 7, 7, 8, 8, 11, 9]
  const jumpGround = Math.max(...sprite.frames.slice(6, 9).map((rect) => rect.y + rect.height))
  const frameLifts = sprite.frames.map((rect, index) => (
    index >= 6 && index < 9 ? jumpGround - rect.y - rect.height : 0
  ))
  // A single scale for the entire sheet prevents breathing/turning from resizing
  // the pet. Preserve the source jump height, including any painted ground shadow.
  const scale = Math.min(
    116 / Math.max(...sprite.frames.map((rect) => rect.width)),
    112 / Math.max(...sprite.frames.map((rect, index) => rect.height + frameLifts[index])),
  )
  return {
    type: 'atlas', src: sprite.src, outfitKey,
    frameIndices, frameCount: frameIndices.length,
    frameDuration: DURATIONS[action] || 110,
    geometry: {
      width: sprite.width, height: sprite.height,
      frameRects: sprite.frames, scale, frameLifts,
    },
  }
}
