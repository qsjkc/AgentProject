import { useEffect, useMemo, useRef, useState } from 'react'

import { getPetAnimation } from '../shared/pet-animation-config'
import { isLoopingPetAnimation } from '../shared/pet-animation-state'

export function PetAnimator({ petType, action, cycleId = null, alt, onCycleComplete }) {
  const animation = useMemo(() => getPetAnimation(petType, action), [petType, action])
  const { frameCount, frameDuration } = animation
  const [index, setIndex] = useState(0)
  const previousIndexRef = useRef(0)
  const resettingAnimationRef = useRef(false)

  useEffect(() => {
    resettingAnimationRef.current = true
    previousIndexRef.current = 0
    setIndex(0)
  }, [action, cycleId, petType])

  useEffect(() => {
    if (frameCount <= 1) {
      if (isLoopingPetAnimation(action)) {
        return undefined
      }
      const timer = window.setTimeout(() => {
        onCycleComplete?.(action, cycleId)
      }, 660)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % frameCount)
    }, frameDuration)

    return () => window.clearInterval(timer)
  }, [action, cycleId, frameCount, frameDuration, onCycleComplete])

  useEffect(() => {
    if (resettingAnimationRef.current) {
      if (index === 0) {
        resettingAnimationRef.current = false
      }
      return
    }
    if (frameCount <= 1 || isLoopingPetAnimation(action)) {
      previousIndexRef.current = index
      return
    }
    if (index === 0 && previousIndexRef.current === frameCount - 1) {
      onCycleComplete?.(action, cycleId)
    }
    previousIndexRef.current = index
  }, [action, cycleId, frameCount, index, onCycleComplete])

  if (animation.type === 'sprite') {
    const column = index % animation.columns
    const row = Math.floor(index / animation.columns)
    const x = animation.columns > 1 ? (column / (animation.columns - 1)) * 100 : 0
    const y = animation.rows > 1 ? (row / (animation.rows - 1)) * 100 : 0

    return (
      <div
        className="pet-image pet-sprite"
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
      src={animation.frames[index] || animation.frames[0]}
      alt={alt}
      draggable="false"
    />
  )
}
