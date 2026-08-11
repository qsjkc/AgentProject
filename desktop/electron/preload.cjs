const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  openMainPanel: () => ipcRenderer.invoke('desktop:open-main-panel'),
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
  notifyPetReminderEvent: (payload) => ipcRenderer.invoke('desktop:notify-pet-reminder-event', payload),
  getCachedPetRelationship: (petType) => ipcRenderer.invoke('desktop:get-cached-pet-relationship', petType),
  cachePetRelationship: (payload) => ipcRenderer.invoke('desktop:cache-pet-relationship', payload),
  getPetMilestonePlayback: (petType) => ipcRenderer.invoke('desktop:get-pet-milestone-playback', petType),
  setPetMilestonePlayback: (petType, playback, expectedRevision) => (
    ipcRenderer.invoke('desktop:set-pet-milestone-playback', petType, playback, expectedRevision)
  ),
  clearPetMilestonePlayback: (petType, claimToken, expectedRevision) => (
    ipcRenderer.invoke('desktop:clear-pet-milestone-playback', petType, claimToken, expectedRevision)
  ),
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
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:pet-relationship-changed', listener)
    return () => ipcRenderer.removeListener('desktop:pet-relationship-changed', listener)
  },
  toggleAutoLaunch: (enabled) => ipcRenderer.invoke('desktop:toggle-auto-launch', enabled),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  showNotification: (payload) => ipcRenderer.invoke('desktop:show-notification', payload),
  getApiBaseUrl: () => ipcRenderer.invoke('desktop:get-api-base-url'),
  setApiBaseUrl: (value) => ipcRenderer.invoke('desktop:set-api-base-url', value),
  getLanguage: () => ipcRenderer.invoke('desktop:get-language'),
  setLanguage: (value) => ipcRenderer.invoke('desktop:set-language', value),
  getVoiceSettings: () => ipcRenderer.invoke('desktop:get-voice-settings'),
  updateVoiceSettings: (patch) => ipcRenderer.invoke('desktop:update-voice-settings', patch),
  getCompanionSettings: () => ipcRenderer.invoke('desktop:get-companion-settings'),
  updateCompanionSettings: (patch) => ipcRenderer.invoke('desktop:update-companion-settings', patch),
  getCompanionState: (petType) => ipcRenderer.invoke('desktop:get-companion-state', petType),
  setCompanionState: (petType, state) => ipcRenderer.invoke('desktop:set-companion-state', petType, state),
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
  getPetBounds: () => ipcRenderer.invoke('desktop:get-pet-bounds'),
  setPetPosition: (position) => ipcRenderer.invoke('desktop:set-pet-position', position),
  getSessionToken: () => ipcRenderer.invoke('desktop:get-session-token'),
  setSessionToken: (token) => ipcRenderer.invoke('desktop:set-session-token', token),
  clearSessionToken: () => ipcRenderer.invoke('desktop:clear-session-token'),
  logDebug: (payload) => ipcRenderer.invoke('desktop:log-debug', payload),
  sendRendererHeartbeat: (payload) => ipcRenderer.invoke('desktop:renderer-heartbeat', payload),
  getRuntimeState: () => ipcRenderer.invoke('desktop:get-runtime-state'),
  getLogPaths: () => ipcRenderer.invoke('desktop:get-log-paths'),
})
