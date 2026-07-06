import pigIdle01 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-01.png'
import pigIdle02 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-02.png'
import pigIdle03 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-03.png'
import pigIdle04 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-04.png'
import pigIdle05 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-05.png'
import pigIdle06 from '../../../frontend/src/assets/pets/pig/animations/idle/frame-06.png'
import pigWalk01 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-01.png'
import pigWalk02 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-02.png'
import pigWalk03 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-03.png'
import pigWalk04 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-04.png'
import pigWalk05 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-05.png'
import pigWalk06 from '../../../frontend/src/assets/pets/pig/animations/walk/frame-06.png'
import pigJump01 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-01.png'
import pigJump02 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-02.png'
import pigJump03 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-03.png'
import pigJump04 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-04.png'
import pigJump05 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-05.png'
import pigJump06 from '../../../frontend/src/assets/pets/pig/animations/jump/frame-06.png'
import pigHappy01 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-01.png'
import pigHappy02 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-02.png'
import pigHappy03 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-03.png'
import pigHappy04 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-04.png'
import pigHappy05 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-05.png'
import pigHappy06 from '../../../frontend/src/assets/pets/pig/animations/happy/frame-06.png'
import pigConfused01 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-01.png'
import pigConfused02 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-02.png'
import pigConfused03 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-03.png'
import pigConfused04 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-04.png'
import pigConfused05 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-05.png'
import pigConfused06 from '../../../frontend/src/assets/pets/pig/animations/confused/frame-06.png'
import pigReminding01 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-01.png'
import pigReminding02 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-02.png'
import pigReminding03 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-03.png'
import pigReminding04 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-04.png'
import pigReminding05 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-05.png'
import pigReminding06 from '../../../frontend/src/assets/pets/pig/animations/reminding/frame-06.png'
import pigSleeping01 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-01.png'
import pigSleeping02 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-02.png'
import pigSleeping03 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-03.png'
import pigSleeping04 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-04.png'
import pigSleeping05 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-05.png'
import pigSleeping06 from '../../../frontend/src/assets/pets/pig/animations/sleeping/frame-06.png'

import { getPetVisual } from './pets'

const pigAnimations = {
  idle: [pigIdle01, pigIdle02, pigIdle03, pigIdle04, pigIdle05, pigIdle06],
  walk: [pigWalk01, pigWalk02, pigWalk03, pigWalk04, pigWalk05, pigWalk06],
  jump: [pigJump01, pigJump02, pigJump03, pigJump04, pigJump05, pigJump06],
  happy: [pigHappy01, pigHappy02, pigHappy03, pigHappy04, pigHappy05, pigHappy06],
  confused: [pigConfused01, pigConfused02, pigConfused03, pigConfused04, pigConfused05, pigConfused06],
  reminding: [pigReminding01, pigReminding02, pigReminding03, pigReminding04, pigReminding05, pigReminding06],
  sleeping: [pigSleeping01, pigSleeping02, pigSleeping03, pigSleeping04, pigSleeping05, pigSleeping06],
}

export function getPetAnimationFrames(petType, action) {
  if (petType === 'pig' && pigAnimations[action]?.length) {
    return pigAnimations[action]
  }

  const fallbackMood = action === 'happy' || action === 'jump' ? 'happy' : action === 'confused' ? 'sad' : 'idle'
  return [getPetVisual(petType, fallbackMood).image]
}
