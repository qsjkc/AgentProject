import { getPetOutfitCatalog } from '../shared/pet-outfits'
import { getDressedPetAnimation } from '../shared/pet-dressed-assets'
import { getAtlasFrameLayout } from '../shared/pet-sprite-animation'

// Wardrobe cards show the actual dressed character, including the other slots
// already worn. The pet itself is painted by PetAnimator as one complete frame.
export function OutfitSprite({ petType, itemId, outfit = null, className = '' }) {
  const preview = {
    equipped_outfits: outfit?.equipped_outfits || {},
    unlocked_outfit_ids: getPetOutfitCatalog(petType).map((item) => item.id),
  }
  const animation = getDressedPetAnimation(petType, 'idle', preview, itemId)
  if (!animation) return null
  const { rect, x, y, width, height } = getAtlasFrameLayout(animation, 0)
  return (
    <svg className={`outfit-sprite ${className}`.trim()} viewBox="0 0 126 126"
      data-outfit-key={animation.outfitKey} aria-hidden="true">
      <svg x={x} y={y} width={width} height={height}
        viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} overflow="hidden">
        <image href={animation.src} width={animation.geometry.width} height={animation.geometry.height} />
      </svg>
    </svg>
  )
}
