import { applyPetOutfitPreview, PET_OUTFIT_SLOTS } from '../shared/pet-outfits'
import {
  getPetOutfitSpriteStyle,
  getPetOutfitVisual,
} from '../shared/pet-outfit-visuals'

const OUTFIT_COMPATIBLE_ACTIONS = new Set([
  'idle',
  'dress_up',
  'run',
  'stretch',
  'look_around',
  'yawn',
  'welcome_back',
  'level_up',
])

function getEffectiveOutfits(petType, action, outfit, previewItemId) {
  const effectiveOutfit = applyPetOutfitPreview(outfit, petType, previewItemId)
  const unlocked = new Set(effectiveOutfit.unlocked_outfit_ids || [])

  if (!['pig', 'cat', 'dog'].includes(petType)) {
    return []
  }

  if (action === 'sleeping') {
    const itemId = `${petType}_sleep_cap`
    return unlocked.has(itemId) ? [itemId] : []
  }
  if (action === 'reminding') {
    const itemId = `${petType}_bell`
    return unlocked.has(itemId) ? [itemId] : []
  }
  if (!OUTFIT_COMPATIBLE_ACTIONS.has(action)) {
    return []
  }

  const equipped = effectiveOutfit.equipped_outfits || {}
  return PET_OUTFIT_SLOTS
    .map((slot) => equipped[slot])
    .filter(Boolean)
}

export function OutfitSprite({ petType, itemId, className = '' }) {
  const style = getPetOutfitSpriteStyle(petType, itemId)
  if (!style) {
    return null
  }

  return (
    <span
      className={`outfit-sprite ${className}`.trim()}
      style={style}
      aria-hidden="true"
    />
  )
}

export function PetOutfitRenderer({ petType, action, outfit, previewItemId = null }) {
  const itemIds = getEffectiveOutfits(petType, action, outfit, previewItemId)
  if (!itemIds.length) {
    return null
  }

  return (
    <div className="pet-outfit-layer" aria-hidden="true">
      {itemIds.map((itemId) => {
        const visual = getPetOutfitVisual(petType, itemId, action)
        return visual ? (
          <span
            key={itemId}
            className={`pet-outfit-item pet-outfit-item-${itemId}`}
            style={visual.style}
          />
        ) : null
      })}
    </div>
  )
}
