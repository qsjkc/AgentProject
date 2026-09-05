function createPetOnboardingStateBroadcaster({
  getCurrentState,
  projectStateForRole,
  send,
} = {}) {
  const pendingSenders = new WeakSet()

  const getTarget = (windowInstance) => {
    if (
      !windowInstance
      || windowInstance.isDestroyed?.()
      || !['pet', 'main-panel'].includes(windowInstance.__role)
      || !windowInstance.webContents
    ) {
      return null
    }
    return {
      role: windowInstance.__role,
      sender: windowInstance.webContents,
      windowInstance,
    }
  }

  const deliverLatest = (windowInstance) => {
    const target = getTarget(windowInstance)
    if (!target || target.sender.isDestroyed?.()) {
      return false
    }
    const state = getCurrentState?.() ?? null
    const projected = projectStateForRole?.(state, target.role) ?? null
    send?.(target.windowInstance, projected)
    return true
  }

  const sendLatest = (windowInstance) => {
    const target = getTarget(windowInstance)
    if (!target || target.sender.isDestroyed?.()) {
      return false
    }
    if (pendingSenders.has(target.sender)) {
      return true
    }
    if (!target.sender.isLoading?.()) {
      return deliverLatest(windowInstance)
    }
    if (typeof target.sender.once !== 'function') {
      return false
    }
    pendingSenders.add(target.sender)
    target.sender.once('did-finish-load', () => {
      pendingSenders.delete(target.sender)
      deliverLatest(windowInstance)
    })
    return true
  }

  const isPending = (windowInstance) => {
    const sender = windowInstance?.webContents
    return Boolean(sender && pendingSenders.has(sender))
  }

  return { isPending, sendLatest }
}

module.exports = { createPetOnboardingStateBroadcaster }
