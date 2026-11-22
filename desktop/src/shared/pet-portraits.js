import catHappy from '../../../frontend/src/assets/pets/cat/happy.png'
import catIdle from '../../../frontend/src/assets/pets/cat/idle.png'
import dogHappy from '../../../frontend/src/assets/pets/dog/happy.png'
import dogIdle from '../../../frontend/src/assets/pets/dog/idle.png'
import pigHappy from '../../../frontend/src/assets/pets/pig/happy.png'
import pigIdle from '../../../frontend/src/assets/pets/pig/idle.png'

const petPortraits = new Map([
  ['cat', { idle: catIdle, happy: catHappy }],
  ['dog', { idle: dogIdle, happy: dogHappy }],
  ['pig', { idle: pigIdle, happy: pigHappy }],
])

export function getPetPortrait(petType, mood = 'idle') {
  const portraits = petPortraits.get(petType) ?? petPortraits.get('cat')
  return mood === 'happy' ? portraits.happy : portraits.idle
}
