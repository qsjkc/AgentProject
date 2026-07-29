import { useEffect, useMemo, useRef, useState } from 'react'

import { getPetAnimation } from '../shared/pet-animation-config'

export function PetAnimator({ petType, action, alt, onCycleComplete }) {
  const animation = useMemo(() => getPetAnimation(petType, action), [petType, action])
  const { frameCount, frameDuration } = animation
  const [index, setIndex] = useState(0)
  const previousIndexRef = useRef(0)

  useEffect(() => {
    previousIndexRef.current = 0
    setIndex(0)
  }, [action, petType])

  useEffect(() => {
    if (frameCount <= 1) {
      if (action === 'idle') {
        return undefined
      }
      const timer = window.setTimeout(() => {
        onCycleComplete?.(action)
      }, 660)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % frameCount)
    }, frameDuration)

    return () => window.clearInterval(timer)
  }, [action, frameCount, frameDuration, onCycleComplete])

  useEffect(() => {
    if (frameCount <= 1 || action === 'idle') {
      previousIndexRef.current = index
      return
    }
    if (index === 0 && previousIndexRef.current === frameCount - 1) {
      onCycleComplete?.(action)
    }
    previousIndexRef.current = index
  }, [action, frameCount, index, onCycleComplete])

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
