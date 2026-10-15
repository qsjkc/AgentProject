function normalizePositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function hasExactSemanticIdentity(state, semantic) {
  return Boolean(
    state?.authenticated
    && normalizePositiveInteger(state.userId) === normalizePositiveInteger(semantic?.userId)
    && state.petType === semantic?.petType
    && normalizePositiveInteger(state.relationshipId) === normalizePositiveInteger(semantic?.relationshipId)
  )
}

export function createMainPanelIntentConsumerController({
  getState,
  validateCapability,
  showOverride,
  clearOverride,
  acknowledge,
  commitTab,
} = {}) {
  let ownerSequence = 0
  let ownerId = null

  const clear = (sequence, id) => {
    if (ownerSequence !== sequence || ownerId !== id) return false
    ownerId = null
    clearOverride?.(id)
    return true
  }

  return {
    async consume(payload) {
      const id = payload?.id
      const semantic = payload?.semantic
      const capability = payload?.authoritative
      if (
        typeof id !== 'string'
        || !id
        || !capability?.id
        || !hasExactSemanticIdentity(getState?.(), semantic)
      ) return false

      ownerSequence += 1
      const sequence = ownerSequence
      ownerId = id
      try {
        if (!await validateCapability?.(capability, 'relationship', semantic)) {
          clear(sequence, id)
          return false
        }
        if (!hasExactSemanticIdentity(getState?.(), semantic)) {
          clear(sequence, id)
          return false
        }
        const target = await showOverride?.(payload)
        if (
          ownerSequence !== sequence
          || ownerId !== id
          || !target?.scrollIntoView
          || !hasExactSemanticIdentity(getState?.(), semantic)
          || !await validateCapability?.(capability, 'relationship', semantic)
          || !hasExactSemanticIdentity(getState?.(), semantic)
        ) {
          clear(sequence, id)
          return false
        }
        target.scrollIntoView({ block: 'nearest' })
        if (
          ownerSequence !== sequence
          || ownerId !== id
          || !hasExactSemanticIdentity(getState?.(), semantic)
          || !await validateCapability?.(capability, 'relationship', semantic)
        ) {
          clear(sequence, id)
          return false
        }
        const acknowledged = await acknowledge?.(id)
        if (
          acknowledged !== true
          || ownerSequence !== sequence
          || ownerId !== id
          || !hasExactSemanticIdentity(getState?.(), semantic)
        ) {
          clear(sequence, id)
          return false
        }
        commitTab?.('chat')
        clear(sequence, id)
        return true
      } catch {
        clear(sequence, id)
        return false
      }
    },
    cancel() {
      ownerSequence += 1
      const previousId = ownerId
      ownerId = null
      if (previousId) clearOverride?.(previousId)
    },
  }
}

export { hasExactSemanticIdentity }
