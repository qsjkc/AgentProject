import { useEffect, useMemo, useRef, useState } from 'react'

import { getPetAnimation } from '../shared/pet-animation-config'
import { isLoopingPetAnimation } from '../shared/pet-animation-state'
import { createPetAnimationPlayback } from '../shared/pet-animation-playback'

export function PetAnimator({ petType, action, cycleId = null, alt, onCycleComplete }) {
  const animation = useMemo(() => getPetAnimation(petType, action), [petType, action])
  const { frameCount, frameDuration } = animation
  const [index, setIndex] = useState(0)
  const onCompleteRef = useRef(onCycleComplete)
  onCompleteRef.current = onCycleComplete

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const policy = () => ({ visible: document.visibilityState !== 'hidden', reducedMotion: media.matches })
    const playback = createPetAnimationPlayback({
      frameCount,
      frameDuration,
      looping: isLoopingPetAnimation(action),
      ...policy(),
      onFrame: setIndex,
      onComplete: () => onCompleteRef.current?.(action, cycleId),
    })
    const update = () => playback.updatePolicy(policy())
    document.addEventListener('visibilitychange', update)
    media.addEventListener('change', update)
    return () => {
      playback.dispose()
      document.removeEventListener('visibilitychange', update)
      media.removeEventListener('change', update)
    }
  }, [action, cycleId, petType, frameCount, frameDuration])

  if (animation.type === 'sprite') {
    const column = index % animation.columns
    const row = Math.floor(index / animation.columns)
    const x = animation.columns > 1 ? (column / (animation.columns - 1)) * 100 : 0
    const y = animation.rows > 1 ? (row / (animation.rows - 1)) * 100 : 0

    return (
      <div
        className="pet-image pet-sprite"
        data-animation-frame={index}
        role="img"
        aria-label={alt}
        style={{
          backgroundImage: `url(${animation.src})`,
          backgroundPosition: `${x}% ${y}%`,
          backgroundSize: `${animation.columns * 100}% ${animation.rows * 100}%`,
        }}
      />
    )
  }

  return (
    <img
      className="pet-image"
      data-animation-frame={index}
      src={animation.frames[index] || animation.frames[0]}
      alt={alt}
      draggable="false"
    />
  )
}
