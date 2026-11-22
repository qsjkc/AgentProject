function createPetOnboardingStateBroadcaster({
  getCurrentState,
  projectStateForRole,
  send,
} = {}) {
  const pendingLoads = new WeakMap()

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
    const { sender } = target
    const pendingLoad = pendingLoads.get(sender)
    if (!sender.isLoading?.()) {
      if (pendingLoad) {
        pendingLoads.delete(sender)
        sender.removeListener?.('did-finish-load', pendingLoad)
      }
      return deliverLatest(windowInstance)
    }
    if (pendingLoad) {
      return true
    }
    if (typeof sender.once !== 'function') {
      return false
    }
    const onFinishLoad = () => {
      if (pendingLoads.get(sender) !== onFinishLoad) return
      pendingLoads.delete(sender)
      deliverLatest(windowInstance)
    }
    pendingLoads.set(sender, onFinishLoad)
    sender.once('did-finish-load', onFinishLoad)
    return true
  }

  const isPending = (windowInstance) => {
    const sender = windowInstance?.webContents
    return Boolean(sender && pendingLoads.has(sender))
  }

  return { isPending, sendLatest }
}

module.exports = { createPetOnboardingStateBroadcaster }
