import catExcited from '../../../frontend/src/assets/pets/cat/excited.png'
import catHappy from '../../../frontend/src/assets/pets/cat/happy.png'
import catIdle from '../../../frontend/src/assets/pets/cat/idle.png'
import catSad from '../../../frontend/src/assets/pets/cat/sad.png'
import dogExcited from '../../../frontend/src/assets/pets/dog/excited.png'
import dogHappy from '../../../frontend/src/assets/pets/dog/happy.png'
import dogIdle from '../../../frontend/src/assets/pets/dog/idle.png'
import dogSad from '../../../frontend/src/assets/pets/dog/sad.png'
import pigExcited from '../../../frontend/src/assets/pets/pig/excited.png'
import pigHappy from '../../../frontend/src/assets/pets/pig/happy.png'
import pigIdle from '../../../frontend/src/assets/pets/pig/idle.png'
import pigSad from '../../../frontend/src/assets/pets/pig/sad.png'

export const PET_MOODS = ['idle', 'happy', 'excited', 'sad']

export const petVisualMap = {
  cat: {
    labelKey: 'petCat',
    images: {
      idle: catIdle,
      happy: catHappy,
      excited: catExcited,
      sad: catSad,
    },
  },
  dog: {
    labelKey: 'petDog',
    images: {
      idle: dogIdle,
      happy: dogHappy,
      excited: dogExcited,
      sad: dogSad,
    },
  },
  pig: {
    labelKey: 'petPig',
    images: {
      idle: pigIdle,
      happy: pigHappy,
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
