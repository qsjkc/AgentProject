let authenticationIntent = 0

export function createAuthFormOperations(readToken: () => string | null) {
  let active = false
  let generation = 0
  let pending: object | null = null

  const invalidate = () => {
    generation += 1
    pending = null
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
    begin(kind: 'submit' | 'code') {
      if (!active || pending) return null
      if (kind === 'submit') authenticationIntent += 1
      const intent = authenticationIntent
      const operationGeneration = generation
      const token = readToken()
      const key = {}
      pending = key
      return {
        isCurrent: () => active
          && pending === key
          && operationGeneration === generation
          && intent === authenticationIntent
          && token === readToken(),
        finish() {
          if (pending === key) pending = null
        },
      }
    },
  }
}
