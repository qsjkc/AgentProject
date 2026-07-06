import { useEffect, useMemo, useRef, useState } from 'react'

import { getPetAnimationFrames } from '../shared/pet-animation-config'

export function PetAnimator({ petType, action, alt, onCycleComplete }) {
  const frames = useMemo(() => getPetAnimationFrames(petType, action), [petType, action])
  const [index, setIndex] = useState(0)
  const previousIndexRef = useRef(0)

  useEffect(() => {
    previousIndexRef.current = 0
    setIndex(0)
  }, [action, petType])

  useEffect(() => {
    if (frames.length <= 1) {
      if (action === 'idle') {
        return undefined
      }
      const timer = window.setTimeout(() => {
        onCycleComplete?.(action)
      }, 660)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % frames.length)
    }, 110)

    return () => window.clearInterval(timer)
  }, [action, frames.length, onCycleComplete])

  useEffect(() => {
    if (frames.length <= 1 || action === 'idle') {
      previousIndexRef.current = index
      return
    }
    if (index === 0 && previousIndexRef.current === frames.length - 1) {
      onCycleComplete?.(action)
    }
    previousIndexRef.current = index
  }, [action, frames.length, index, onCycleComplete])

  return <img className="pet-image" src={frames[index] || frames[0]} alt={alt} draggable="false" />
}
