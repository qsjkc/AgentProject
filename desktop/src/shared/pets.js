import catExcited from '../../../frontend/src/assets/pets/cat/excited.png'
import catSad from '../../../frontend/src/assets/pets/cat/sad.png'
import dogExcited from '../../../frontend/src/assets/pets/dog/excited.png'
import dogSad from '../../../frontend/src/assets/pets/dog/sad.png'
import pigExcited from '../../../frontend/src/assets/pets/pig/excited.png'
import pigSad from '../../../frontend/src/assets/pets/pig/sad.png'

import { getPetLabelKey } from './pet-labels'
import { getPetPortrait } from './pet-portraits'

export const PET_MOODS = ['idle', 'happy', 'excited', 'sad']

// Renderer entries import the label and portrait helpers directly so Vite
// does not emit the full mood image set when only an idle or happy portrait is used.
export const petVisualMap = {
  cat: {
    labelKey: getPetLabelKey('cat'),
    images: {
      idle: getPetPortrait('cat'),
      happy: getPetPortrait('cat', 'happy'),
      excited: catExcited,
      sad: catSad,
    },
  },
  dog: {
    labelKey: getPetLabelKey('dog'),
    images: {
      idle: getPetPortrait('dog'),
      happy: getPetPortrait('dog', 'happy'),
      excited: dogExcited,
      sad: dogSad,
    },
  },
  pig: {
    labelKey: getPetLabelKey('pig'),
    images: {
      idle: getPetPortrait('pig'),
      happy: getPetPortrait('pig', 'happy'),
      excited: pigExcited,
      sad: pigSad,
    },
  },
}

export function getPetVisual(petType, mood = 'idle') {
  const pet = petVisualMap[petType] || petVisualMap.cat
  return {
    labelKey: pet.labelKey,
    image: pet.images[mood] || pet.images.idle,
  }
}
