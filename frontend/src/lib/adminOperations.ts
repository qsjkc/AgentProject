interface AdminSession {
  token: string | null
  userId: number | null
}

/** Coordinates one mounted admin screen without sharing work between accounts. */
export function createAdminOperations(readSession: () => AdminSession) {
  let active = false
  let generation = 0
  let readRevision = 0
  let mutation: object | null = null

  const invalidate = () => {
    generation += 1
    readRevision += 1
    mutation = null
  }

  const captureSession = () => {
    const session = readSession()
    const capturedGeneration = generation
    return () => {
      const current = readSession()
      return active
        && capturedGeneration === generation
        && Boolean(session.token)
        && session.userId !== null
        && current.token === session.token
        && current.userId === session.userId
    }
  }

  return {
    mount() {
      invalidate()
      active = true
    },
    unmount() {
      active = false
      invalidate()
    },
    invalidate,
    beginRead() {
      const revision = ++readRevision
      const isSessionCurrent = captureSession()
      return { isCurrent: () => revision === readRevision && isSessionCurrent() }
    },
    beginMutation() {
      if (!active || mutation) return null
      const key = {}
      const isSessionCurrent = captureSession()
      if (!isSessionCurrent()) return null
      mutation = key
      return {
        isCurrent: () => mutation === key && isSessionCurrent(),
        finish() {
          if (mutation === key) mutation = null
        },
      }
    },
  }
}
