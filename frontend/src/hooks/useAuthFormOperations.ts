import { useCallback, useEffect, useState } from 'react'

import { createAuthFormOperations } from '../lib/authFormOperations'
import { useAuthStore } from '../stores'

export function useAuthFormOperations() {
  const [operations] = useState(() => createAuthFormOperations(() => useAuthStore.getState().token))
  const [busy, setBusy] = useState<'submit' | 'code' | null>(null)
  const invalidate = useCallback(() => {
    operations.invalidate()
    setBusy(null)
  }, [operations])

  useEffect(() => {
    operations.mount()
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      if (next.token !== previous.token) invalidate()
    })
    return () => {
      unsubscribe()
      operations.unmount()
    }
  }, [invalidate, operations])

  return {
    busy,
    invalidate,
    begin(kind: 'submit' | 'code') {
      const operation = operations.begin(kind)
      if (!operation) return null
      setBusy(kind)
      return {
        isCurrent: operation.isCurrent,
        finish() {
          if (operation.isCurrent()) setBusy(null)
          operation.finish()
        },
      }
    },
  }
}
