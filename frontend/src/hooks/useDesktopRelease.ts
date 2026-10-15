import { useCallback, useEffect, useRef, useState } from 'react'

import { publicApi } from '../services'
import type { DesktopRelease } from '../types'

export function useDesktopRelease() {
  const [release, setRelease] = useState<DesktopRelease | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const generation = useRef(0)

  const retry = useCallback(async () => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setError(false)
    try {
      const nextRelease = await publicApi.getWindowsRelease()
      if (requestGeneration === generation.current) setRelease(nextRelease)
    } catch {
      if (requestGeneration === generation.current) setError(true)
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void retry()
    return () => { generation.current += 1 }
  }, [retry])

  return { release, loading, error, retry }
}
