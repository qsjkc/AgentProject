import { useEffect, useMemo, useState } from 'react'

export function useCooldownTimer(durationSeconds = 180) {
  const [remainingSeconds, setRemainingSeconds] = useState(0)

  useEffect(() => {
    if (remainingSeconds <= 0) {
      return undefined
    }

    const timerId = window.setInterval(() => {
      setRemainingSeconds((current) => (current > 1 ? current - 1 : 0))
    }, 1000)

    return () => window.clearInterval(timerId)
  }, [remainingSeconds])

  const formattedTime = useMemo(() => {
    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }, [remainingSeconds])

  return {
    isCountingDown: remainingSeconds > 0,
    remainingSeconds,
    formattedTime,
    start: () => setRemainingSeconds(durationSeconds),
    reset: () => setRemainingSeconds(0),
  }
}
