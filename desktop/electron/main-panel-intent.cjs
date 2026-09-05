const { randomUUID } = require('node:crypto')

function createMainPanelIntentCoordinator({
  timeoutMs,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  createId = randomUUID,
  deliver,
  validateContext,
} = {}) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : 5000
  let rendererReady = false
  let pending = null

  const isPendingContextCurrent = () => (
    !pending?.context
    || typeof validateContext !== 'function'
    || validateContext(pending.context) === true
  )

  const settlePending = (consumed) => {
    if (!pending) {
      return false
    }
    const current = pending
    pending = null
    cancelTimeout(current.timeoutId)
    current.resolve(Boolean(consumed))
    return true
  }

  const flush = () => {
    if (!rendererReady || !pending || pending.delivered) {
      return false
    }
    if (!isPendingContextCurrent()) {
      return settlePending(false)
    }
    let delivered = false
    try {
      const payload = { id: pending.id, intent: pending.intent }
      if (pending.context !== undefined) payload.authoritative = pending.context
      if (pending.semantic !== undefined) payload.semantic = pending.semantic
      delivered = deliver?.(payload) !== false
    } catch {
      delivered = false
    }
    if (!delivered) {
      return settlePending(false)
    }
    pending.delivered = true
    return true
  }

  return {
    request(intent, { context, semantic } = {}) {
      settlePending(false)
      return new Promise((resolve) => {
        const timeoutId = scheduleTimeout(() => settlePending(false), boundedTimeoutMs)
        pending = {
          id: createId(),
          intent,
          resolve,
          timeoutId,
          delivered: false,
          context,
          semantic,
        }
        flush()
      })
    },
    markRendererReady() {
      rendererReady = true
      return flush()
    },
    markRendererNotReady() {
      rendererReady = false
      if (pending) {
        pending.delivered = false
      }
    },
    acknowledge(id) {
      if (!pending || !pending.delivered || typeof id !== 'string' || id !== pending.id) {
        return false
      }
      if (!isPendingContextCurrent()) {
        settlePending(false)
        return false
      }
      return settlePending(true)
    },
    failPending() {
      rendererReady = false
      return settlePending(false)
    },
    getPendingMetadata() {
      if (!pending) return null
      return {
        intent: pending.intent,
        semantic: pending.semantic ? { ...pending.semantic } : null,
      }
    },
    hasPending() {
      return Boolean(pending)
    },
    rebindPendingContext(context) {
      if (!pending || !context) return false
      pending.context = context
      pending.delivered = false
      return true
    },
  }
}

function createMainPanelIntentListenerRegistry({
  onReady,
  onNotReady,
  acknowledge,
  validateContext,
  now = Date.now,
  seenTtlMs = 30000,
  maxSeenIds = 128,
} = {}) {
  const listeners = new Set()
  const inFlightIds = new Set()
  const seenIds = new Map()
  const cleanupSeenIds = () => {
    const cutoff = Number(now()) - seenTtlMs
    for (const [id, seenAt] of seenIds) {
      if (seenAt <= cutoff) seenIds.delete(id)
    }
    while (seenIds.size > maxSeenIds) seenIds.delete(seenIds.keys().next().value)
  }

  return {
    add(callback) {
      if (typeof callback !== 'function') {
        return () => undefined
      }
      const wasEmpty = listeners.size === 0
      listeners.add(callback)
      if (wasEmpty) {
        onReady?.()
      }
      let active = true
      return () => {
        if (!active) {
          return
        }
        active = false
        listeners.delete(callback)
        if (listeners.size === 0) {
          onNotReady?.()
        }
      }
    },
    async consume(payload) {
      cleanupSeenIds()
      const id = payload?.id
      if (
        typeof id !== 'string'
        || !id
        || listeners.size === 0
        || inFlightIds.has(id)
        || seenIds.has(id)
      ) {
        return false
      }
      const capability = payload?.authoritative ?? payload?.context
      if (capability && validateContext && !await validateContext(capability)) {
        return false
      }
      seenIds.set(id, Number(now()))
      cleanupSeenIds()
      inFlightIds.add(id)
      const snapshot = [...listeners]
      const transactions = []
      const rollback = async () => {
        await Promise.allSettled(transactions.map((transaction) => transaction.rollback?.()))
      }
      try {
        const results = await Promise.all(snapshot.map((listener) => listener(payload)))
        if (
          listeners.size === 0
          || snapshot.some((listener) => !listeners.has(listener))
          || results.some((result) => result === false)
        ) {
          await rollback()
          return false
        }
        transactions.push(...results.filter((result) => (
          result && typeof result === 'object' && typeof result.commit === 'function'
        )))
        if (capability && validateContext && !await validateContext(capability)) {
          await rollback()
          return false
        }
        for (const transaction of transactions) {
          await transaction.commit()
        }
        if (capability && validateContext && !await validateContext(capability)) {
          await rollback()
          return false
        }
        const accepted = await acknowledge?.(id)
        if (accepted === false) {
          await rollback()
          return false
        }
        return true
      } catch {
        await rollback()
        return false
      } finally {
        inFlightIds.delete(id)
      }
    },
    size() {
      return listeners.size
    },
  }
}

module.exports = {
  createMainPanelIntentCoordinator,
  createMainPanelIntentListenerRegistry,
}
