import catIdle from '../../../frontend/src/assets/pets/cat/idle.png'
import dogIdle from '../../../frontend/src/assets/pets/dog/idle.png'
import pigIdle from '../../../frontend/src/assets/pets/pig/idle.png'

export const petVisualMap = {
  cat: {
    label: 'Cat',
    image: catIdle,
  },
  dog: {
    label: 'Dog',
    image: dogIdle,
  },
  pig: {
    label: 'Pig',
    image: pigIdle,
  },
}

export function getPetVisual(petType) {
  return petVisualMap[petType] || petVisualMap.cat
}
