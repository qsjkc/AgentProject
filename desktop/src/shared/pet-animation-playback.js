// Keep visual playback separate from reminders and other background work.
export function createPetAnimationPlayback({
  frameCount,
  frameDuration,
  looping,
  visible = true,
  reducedMotion = false,
  onFrame,
  onComplete,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const count = Math.max(1, Math.trunc(Number(frameCount) || 1))
  const duration = Math.max(16, Number(frameDuration) || 110)
  let frame = 0
  let timer = null
  let completed = false
  let disposed = false

  const clearTimer = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const complete = () => {
    if (completed || disposed) return
    completed = true
    onComplete?.()
  }
  const arm = () => {
    if (disposed || completed || !visible || (looping && (reducedMotion || count === 1))) return
    const staticFrame = reducedMotion || count === 1
    // A reduced-motion action still settles, so care controls and milestones
    // cannot remain locked just because the user disabled visual animation.
    const delay = staticFrame ? (count === 1 ? 660 : count * duration) : duration
    timer = schedule(() => {
      timer = null
      if (disposed || !visible) return
      if (staticFrame) {
        complete()
        return
      }
      frame = (frame + 1) % count
      onFrame?.(frame)
      if (frame === 0 && !looping) complete()
      else arm()
    }, delay)
  }

  onFrame?.(0)
  arm()
  return {
    updatePolicy(next) {
      const nextVisible = next.visible ?? visible
      const nextReduced = next.reducedMotion ?? reducedMotion
      if (nextVisible === visible && nextReduced === reducedMotion) return
      clearTimer()
      visible = nextVisible
      reducedMotion = nextReduced
      if (reducedMotion && frame !== 0) {
        frame = 0
        onFrame?.(0)
      }
      arm()
    },
    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
