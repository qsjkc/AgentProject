import { resolvePetAnimationFrames } from './pet-animation'
import { getPetVisual } from './pets'

export { getPetAnimation } from './pet-animation'

export function getPetAnimationFrames(petType, action) {
  return resolvePetAnimationFrames(petType, action, (type, mood) => getPetVisual(type, mood).image)
}
