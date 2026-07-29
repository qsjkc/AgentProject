import { PET_OUTFIT_SLOTS } from '../shared/pet-outfits'
import {
  getPetOutfitSpriteStyle,
  getPetOutfitVisual,
} from '../shared/pet-outfit-visuals'

function getEffectiveOutfits(petType, action, outfit) {
  const unlocked = new Set(outfit?.unlocked_outfit_ids || [])

  if (petType !== 'pig') {
    return []
  }

  if (action === 'sleeping') {
    return unlocked.has('pig_sleep_cap') ? ['pig_sleep_cap'] : []
  }
  if (action === 'reminding') {
    return unlocked.has('pig_bell') ? ['pig_bell'] : []
  }
  if (action !== 'idle') {
    return []
  }

  const equipped = outfit?.equipped_outfits || {}
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

export function PetOutfitRenderer({ petType, action, outfit }) {
  const itemIds = getEffectiveOutfits(petType, action, outfit)
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
