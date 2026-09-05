const { contextBridge, ipcRenderer } = require('electron')
const { randomUUID } = require('node:crypto')
const { createMainPanelIntentListenerRegistry } = require('./main-panel-intent.cjs')

const e2eEnabled = process.argv.includes('--detachym-e2e=1')
const rendererInstanceNonce = randomUUID()
const rendererInstanceReady = ipcRenderer.invoke(
  'desktop:register-renderer-instance',
  rendererInstanceNonce,
).catch(() => false)

async function invokeForRendererInstance(channel, ...args) {
  if (!await rendererInstanceReady) return null
  return ipcRenderer.invoke(channel, ...args, rendererInstanceNonce)
}

let e2eIntentAckMode = 'normal'
let heldMainPanelIntent = null
let pendingRelationshipCapabilityId = null
let e2eRelationship = null
let e2eRelationshipCapabilityAdopted = false
const e2eRelationshipRefreshListeners = new Set()
const e2eReminderPollListeners = new Set()
const e2eSnapshotReaders = new Set()

const invokeE2eControl = (method, ...args) => (
  e2eEnabled ? ipcRenderer.invoke('desktop:e2e-control', method, ...args) : null
)

function resetE2eLocalState() {
  pendingRelationshipCapabilityId = null
  e2eRelationship = null
  e2eRelationshipCapabilityAdopted = false
}

async function renewOperationContextForRenderer(capability, requiredScope, semantic) {
  const renewed = await invokeForRendererInstance(
    'desktop:renew-operation-context',
    capability,
    requiredScope,
    semantic,
  )
  if (e2eEnabled && capability?.id && capability.id === pendingRelationshipCapabilityId) {
    e2eRelationshipCapabilityAdopted = Boolean(renewed?.id)
  }
  return renewed
}

async function renewExpectedContext(expectedContext, requiredScope) {
  if (expectedContext?.authoritative?.id) {
    const semantic = expectedContext.local || {
      userId: expectedContext.userId ?? expectedContext.user_id,
      petType: expectedContext.petType ?? expectedContext.pet_type,
      relationshipId: expectedContext.relationshipId ?? expectedContext.relationship_id,
    }
    const authoritative = await renewOperationContextForRenderer(
      expectedContext.authoritative,
      requiredScope,
      semantic,
    )
    if (!authoritative) {
      return null
    }
    return { ...expectedContext, authoritative }
  }
  return expectedContext
}

async function invokeOnboardingWithRenewedContext(channel, args, contextIndex) {
  const expectedContext = args[contextIndex]
  const renewedContext = await renewExpectedContext(expectedContext, 'relationship')
  if (expectedContext?.authoritative?.id && !renewedContext) {
    return { ok: false, reason: 'context-expired' }
  }
  args[contextIndex] = renewedContext
  return ipcRenderer.invoke(channel, ...args)
}

async function notifyPetReminderEventWithRenewedContext(payload, expectedContext) {
  const renewedContext = await renewExpectedContext(expectedContext, 'pet')
  if (expectedContext?.authoritative?.id && !renewedContext) {
    return false
  }
  return ipcRenderer.invoke('desktop:notify-pet-reminder-event', payload, renewedContext)
}

const mainPanelIntentListeners = createMainPanelIntentListenerRegistry({
  onReady: () => void ipcRenderer.invoke('desktop:main-panel-intent-ready'),
  onNotReady: () => void ipcRenderer.invoke('desktop:main-panel-intent-not-ready'),
  validateContext: (context) => invokeForRendererInstance(
    'desktop:validate-operation-context',
    context,
    'relationship',
    undefined,
  ),
})

ipcRenderer.on('desktop:main-panel-intent', (_event, payload) => {
  if (e2eEnabled && e2eIntentAckMode !== 'normal') {
    heldMainPanelIntent = payload
    if (e2eIntentAckMode === 'false') {
      heldMainPanelIntent = null
      void invokeE2eControl('rejectMainPanelIntent')
    }
    return
  }
  void mainPanelIntentListeners.consume(payload)
})

ipcRenderer.on('desktop:e2e-reset-local', () => {
  resetE2eLocalState()
})

const desktopBridge = {
  openMainPanel: (options) => ipcRenderer.invoke('desktop:open-main-panel', options),
  ackMainPanelIntent: (id) => ipcRenderer.invoke('desktop:main-panel-intent-ack', id),
  minimizeMainPanel: () => ipcRenderer.invoke('desktop:minimize-main-panel'),
  hideMainPanel: () => ipcRenderer.invoke('desktop:hide-main-panel'),
  openQuickChat: () => ipcRenderer.invoke('desktop:open-quick-chat'),
  hideQuickChat: () => ipcRenderer.invoke('desktop:hide-quick-chat'),
  toggleQuickChat: () => ipcRenderer.invoke('desktop:toggle-quick-chat'),
  showPet: () => ipcRenderer.invoke('desktop:show-pet'),
  focusPetWindow: () => ipcRenderer.invoke('desktop:focus-pet-window'),
  resetPetPosition: () => ipcRenderer.invoke('desktop:reset-pet-position'),
  setPetInteractive: (interactive) => ipcRenderer.invoke('desktop:set-pet-interactive', interactive),
  switchPetFromMainPanel: (payload) => ipcRenderer.invoke('desktop:switch-pet-from-main-panel', payload),
  syncPetState: (payload) => ipcRenderer.invoke('desktop:sync-pet-state', payload),
  notifyPetReminderEvent: (payload, expectedContext) => (
    notifyPetReminderEventWithRenewedContext(payload, expectedContext)
  ),
  getCachedPetRelationship: (petType, expectedContext) => (
    ipcRenderer.invoke('desktop:get-cached-pet-relationship', petType, expectedContext)
  ),
  cachePetRelationship: (payload, expectedContext) => (
    ipcRenderer.invoke('desktop:cache-pet-relationship', payload, expectedContext)
  ),
  getPetMilestonePlayback: (petType, expectedContext) => (
    ipcRenderer.invoke('desktop:get-pet-milestone-playback', petType, expectedContext)
  ),
  setPetMilestonePlayback: (petType, playback, expectedRevision, expectedContext) => (
    ipcRenderer.invoke(
      'desktop:set-pet-milestone-playback',
      petType,
      playback,
      expectedRevision,
      expectedContext,
    )
  ),
  clearPetMilestonePlayback: (petType, claimToken, expectedRevision, expectedContext) => (
    ipcRenderer.invoke(
      'desktop:clear-pet-milestone-playback',
      petType,
      claimToken,
      expectedRevision,
      expectedContext,
    )
  ),
  getPetOnboardingState: (petType, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:get-pet-onboarding-state',
      [petType, expectedContext],
      1,
    )
  ),
  recordPetOnboardingObservation: (petType, capabilityId, payload = {}, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:record-pet-onboarding-observation',
      [petType, capabilityId, payload, expectedContext],
      3,
    )
  ),
  recordPetOnboardingEngagement: (petType, deltaMs, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:record-pet-onboarding-engagement',
      [petType, deltaMs, expectedContext],
      2,
    )
  ),
  claimPetOnboardingPresentation: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:claim-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  ackPetOnboardingPresentation: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:ack-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  releasePetOnboardingPresentation: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:release-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  claimPetOnboardingStep: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:claim-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  ackPetOnboardingStep: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:ack-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  releasePetOnboardingStep: (petType, stepId, token, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:release-pet-onboarding-presentation',
      [petType, stepId, token, expectedContext],
      3,
    )
  ),
  snoozePetOnboarding: (petType, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:snooze-pet-onboarding',
      [petType, expectedContext],
      1,
    )
  ),
  dismissPetOnboarding: (petType, expectedContext) => (
    invokeOnboardingWithRenewedContext(
      'desktop:dismiss-pet-onboarding',
      [petType, expectedContext],
      1,
    )
  ),
  onPetOnboardingChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:pet-onboarding-changed', listener)
    return () => ipcRenderer.removeListener('desktop:pet-onboarding-changed', listener)
  },
  onMainPanelIntent: (callback) => {
    return mainPanelIntentListeners.add(callback)
  },
  onPetStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:pet-state-changed', listener)
    return () => ipcRenderer.removeListener('desktop:pet-state-changed', listener)
  },
  onPetReminderEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:pet-reminder-event', listener)
    return () => ipcRenderer.removeListener('desktop:pet-reminder-event', listener)
  },
  onPetRelationshipChanged: (callback) => {
    const listener = (_event, payload) => {
      if (e2eEnabled) {
        e2eRelationship = payload?.relationship || null
        pendingRelationshipCapabilityId = payload?.authoritative?.id || null
        e2eRelationshipCapabilityAdopted = false
      }
      callback(payload)
    }
    ipcRenderer.on('desktop:pet-relationship-changed', listener)
    return () => ipcRenderer.removeListener('desktop:pet-relationship-changed', listener)
  },
  toggleAutoLaunch: (enabled) => ipcRenderer.invoke('desktop:toggle-auto-launch', enabled),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  showNotification: (payload, expectedContext) => (
    ipcRenderer.invoke('desktop:show-notification', payload, expectedContext)
  ),
  getApiBaseUrl: () => ipcRenderer.invoke('desktop:get-api-base-url'),
  setApiBaseUrl: (value) => ipcRenderer.invoke('desktop:set-api-base-url', value),
  getLanguage: () => ipcRenderer.invoke('desktop:get-language'),
  setLanguage: (value) => ipcRenderer.invoke('desktop:set-language', value),
  getVoiceSettings: () => ipcRenderer.invoke('desktop:get-voice-settings'),
  updateVoiceSettings: (patch) => ipcRenderer.invoke('desktop:update-voice-settings', patch),
  getCompanionSettings: () => ipcRenderer.invoke('desktop:get-companion-settings'),
  updateCompanionSettings: (patch) => ipcRenderer.invoke('desktop:update-companion-settings', patch),
  getCompanionState: (petType, expectedContext) => (
    ipcRenderer.invoke('desktop:get-companion-state', petType, expectedContext)
  ),
  setCompanionState: (petType, state, expectedContext) => (
    ipcRenderer.invoke('desktop:set-companion-state', petType, state, expectedContext)
  ),
  getSystemIdleSeconds: () => ipcRenderer.invoke('desktop:get-system-idle-seconds'),
  onCompanionSettingsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:companion-settings-changed', listener)
    return () => ipcRenderer.removeListener('desktop:companion-settings-changed', listener)
  },
  onCompanionStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:companion-state-changed', listener)
    return () => ipcRenderer.removeListener('desktop:companion-state-changed', listener)
  },
  onVoiceSettingsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:voice-settings-changed', listener)
    return () => ipcRenderer.removeListener('desktop:voice-settings-changed', listener)
  },
  onVoiceGlobalShortcut: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:voice-global-shortcut', listener)
    return () => ipcRenderer.removeListener('desktop:voice-global-shortcut', listener)
  },
  getPetState: () => ipcRenderer.invoke('desktop:get-pet-state'),
  captureOperationContext: (scope, expectedContext) => (
    invokeForRendererInstance('desktop:capture-operation-context', scope, expectedContext)
  ),
  renewOperationContext: (capability, requiredScope, semantic) => (
    renewOperationContextForRenderer(capability, requiredScope, semantic)
  ),
  validateOperationContext: (snapshot, requiredScope, semantic) => (
    invokeForRendererInstance(
      'desktop:validate-operation-context',
      snapshot,
      requiredScope,
      semantic,
    )
  ),
  getPetBounds: () => ipcRenderer.invoke('desktop:get-pet-bounds'),
  setPetPosition: (position) => ipcRenderer.invoke('desktop:set-pet-position', position),
  getSessionToken: () => ipcRenderer.invoke('desktop:get-session-token'),
  getSessionSnapshot: () => ipcRenderer.invoke('desktop:get-session-snapshot'),
  setSessionToken: (token) => ipcRenderer.invoke('desktop:set-session-token', token),
  clearSessionToken: (expectedToken) => ipcRenderer.invoke('desktop:clear-session-token', expectedToken),
  logDebug: (payload) => ipcRenderer.invoke('desktop:log-debug', payload),
  sendRendererHeartbeat: (payload) => ipcRenderer.invoke('desktop:renderer-heartbeat', payload),
  getRuntimeState: () => ipcRenderer.invoke('desktop:get-runtime-state'),
  getLogPaths: () => ipcRenderer.invoke('desktop:get-log-paths'),
}

if (e2eEnabled) {
  desktopBridge.e2e = {
    protocolVersion: 1,
    describe: () => invokeE2eControl('describe'),
    reset: async (fixture) => {
      resetE2eLocalState()
      return invokeE2eControl('reset', fixture)
    },
    snapshot: async () => {
      const snapshot = await invokeE2eControl('snapshot')
      return {
        ...snapshot,
        relationship: e2eRelationship || snapshot?.relationship || null,
        relationshipCapabilityAdopted: e2eRelationshipCapabilityAdopted,
        renderer: [...e2eSnapshotReaders].map((read) => read()),
      }
    },
    onSnapshot: (read) => {
      if (typeof read !== 'function') return () => undefined
      e2eSnapshotReaders.add(read)
      return () => e2eSnapshotReaders.delete(read)
    },
    showWindow: (role) => invokeE2eControl('showWindow', role),
    prepareOnboarding: (options) => invokeE2eControl('prepareOnboarding', options),
    expireOperationCapabilities: () => invokeE2eControl('expireOperationCapabilities'),
    switchAccount: async (fixture) => {
      resetE2eLocalState()
      return invokeE2eControl('switchAccount', fixture)
    },
    destroyWindow: (role) => invokeE2eControl('destroyWindow', role),
    recreateWindow: (role) => invokeE2eControl('recreateWindow', role),
    setMainPanelIntentAckMode: async (mode) => {
      if (!['normal', 'hold', 'false', 'timeout'].includes(mode)) return false
      e2eIntentAckMode = mode
      if (mode === 'normal' && heldMainPanelIntent) {
        const payload = heldMainPanelIntent
        heldMainPanelIntent = null
        void mainPanelIntentListeners.consume(payload)
      } else if (mode === 'false' && heldMainPanelIntent) {
        heldMainPanelIntent = null
        await invokeE2eControl('rejectMainPanelIntent')
      }
      return true
    },
    broadcastRelationshipTo: (role, payload) => (
      invokeE2eControl('broadcastRelationshipTo', role, payload)
    ),
    flushReminderPoll: async () => {
      const results = await Promise.allSettled(
        [...e2eReminderPollListeners].map((listener) => listener()),
      )
      return results.length > 0 && results.every((result) => result.status === 'fulfilled')
    },
    triggerRelationshipRefresh: async () => {
      const results = await Promise.allSettled(
        [...e2eRelationshipRefreshListeners].map((listener) => listener()),
      )
      return results.length > 0 && results.every((result) => result.status === 'fulfilled')
    },
    onFlushReminderPoll: (callback) => {
      if (typeof callback !== 'function') return () => undefined
      e2eReminderPollListeners.add(callback)
      return () => e2eReminderPollListeners.delete(callback)
    },
    onRelationshipRefresh: (callback) => {
      if (typeof callback !== 'function') return () => undefined
      e2eRelationshipRefreshListeners.add(callback)
      return () => e2eRelationshipRefreshListeners.delete(callback)
    },
    recordRequestCompletion: (payload) => invokeE2eControl('recordRequestCompletion', payload),
  }
}

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
