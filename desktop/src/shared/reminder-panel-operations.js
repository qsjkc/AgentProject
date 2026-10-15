import { createAccountOperationGate } from './pet-account-context.js'

// A refresh must never overwrite the result of a newer reminder action.
// Keep one refresh in flight so background polling cannot steal its cleanup.
export function createReminderPanelOperations() {
  const loadGate = createAccountOperationGate()
  const actionGate = createAccountOperationGate()
  let pendingLoad = null
  let pendingAction = null

  return {
    loadGate,
    actionGate,
    beginLoad(context) {
      if (pendingLoad || pendingAction) return null
      pendingLoad = loadGate.begin(context)
      return pendingLoad
    },
    finishLoad(request) {
      if (pendingLoad === request) pendingLoad = null
    },
    beginAction(context) {
      if (pendingAction) return null
      loadGate.invalidate()
      pendingLoad = null
      pendingAction = actionGate.begin(context)
      return pendingAction
    },
    finishAction(request) {
      if (pendingAction === request) pendingAction = null
    },
    invalidate() {
      loadGate.invalidate()
      actionGate.invalidate()
      pendingLoad = null
      pendingAction = null
    },
  }
}
