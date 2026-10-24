import { createDressedAnimation, getDressedOutfitKey } from './pet-dressed-animation.js'

// Only rendering metadata enters the app; generation prompts and audit data
// remain in the source manifests. Images are fetched when a costume is used.
const manifests = import.meta.glob([
  '../../../frontend/src/assets/pets/{cat,dog}/outfits/manifest.json',
  '../../../frontend/src/assets/pets/pig/outfits/dressed/manifest.json',
], { eager: true, import: 'sprites' })
const images = import.meta.glob([
  '../../../frontend/src/assets/pets/{cat,dog}/outfits/*.png',
  '../../../frontend/src/assets/pets/pig/outfits/dressed/*.png',
], { eager: true, query: '?url', import: 'default' })

const wardrobe = Object.fromEntries(Object.entries(manifests).map(([path, sprites]) => {
  const petType = path.match(/\/pets\/([^/]+)\//)[1]
  const directory = path.slice(0, path.lastIndexOf('/') + 1)
  return [petType, Object.fromEntries(Object.entries(sprites).map(([key, sprite]) => (
    [key, { ...sprite, src: images[`${directory}${sprite.file}`] }]
  ))) ]
}))

export function getDressedPetAnimation(petType, action, outfit, previewItemId) {
  const key = getDressedOutfitKey(petType, action, outfit, previewItemId)
  const sprite = key && wardrobe[petType]?.[key]
  return sprite?.src ? createDressedAnimation(sprite, action, key) : null
}
