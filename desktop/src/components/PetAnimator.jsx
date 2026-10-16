import { useEffect, useMemo, useRef, useState } from 'react'

import { getPetAnimation } from '../shared/pet-animation-config'
import { isLoopingPetAnimation } from '../shared/pet-animation-state'
import { createPetAnimationPlayback } from '../shared/pet-animation-playback'
import { getAtlasFrameLayout, getSpriteFrameOffset, getSpriteFramePosition } from '../shared/pet-sprite-animation'

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

  if (animation.type === 'atlas') {
    const { rect, x, y, width, height } = getAtlasFrameLayout(animation, index)
    return (
      <svg className="pet-image pet-sprite" viewBox="0 0 126 126"
        data-pet-type={petType} data-animation-frame={index} role="img" aria-label={alt}>
        <svg x={x} y={y} width={width} height={height}
          viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} overflow="hidden">
          <image href={animation.src} width={animation.geometry.width} height={animation.geometry.height} />
        </svg>
      </svg>
    )
  }

  if (animation.type === 'sprite') {
    const { x, y } = getSpriteFramePosition(animation, index)

    return (
      <div
        className="pet-image pet-sprite"
        data-pet-type={petType}
        data-animation-frame={index}
        role="img"
        aria-label={alt}
        style={{
          backgroundImage: `url(${animation.src})`,
          backgroundPosition: `${x}% ${y}%`,
          backgroundSize: `${animation.columns * 100}% ${animation.rows * 100}%`,
          transform: `translateY(${getSpriteFrameOffset(animation, index)}px)`,
        }}
      />
    )
  }

  return (
    <img
      className="pet-image"
      data-pet-type={petType}
      data-animation-frame={index}
      src={animation.frames[index] || animation.frames[0]}
      alt={alt}
      draggable="false"
    />
  )
}
