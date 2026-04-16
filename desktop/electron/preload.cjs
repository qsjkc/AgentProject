const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  openMainPanel: () => ipcRenderer.invoke('desktop:open-main-panel'),
  minimizeMainPanel: () => ipcRenderer.invoke('desktop:minimize-main-panel'),
  hideMainPanel: () => ipcRenderer.invoke('desktop:hide-main-panel'),
  toggleQuickChat: () => ipcRenderer.invoke('desktop:toggle-quick-chat'),
  showPet: () => ipcRenderer.invoke('desktop:show-pet'),
  resetPetPosition: () => ipcRenderer.invoke('desktop:reset-pet-position'),
  setPetInteractive: (interactive) => ipcRenderer.invoke('desktop:set-pet-interactive', interactive),
  switchPetFromMainPanel: (payload) => ipcRenderer.invoke('desktop:switch-pet-from-main-panel', payload),
  syncPetState: (payload) => ipcRenderer.invoke('desktop:sync-pet-state', payload),
  onPetStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:pet-state-changed', listener)
    return () => ipcRenderer.removeListener('desktop:pet-state-changed', listener)
  },
  toggleAutoLaunch: (enabled) => ipcRenderer.invoke('desktop:toggle-auto-launch', enabled),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  showNotification: (payload) => ipcRenderer.invoke('desktop:show-notification', payload),
  getApiBaseUrl: () => ipcRenderer.invoke('desktop:get-api-base-url'),
  setApiBaseUrl: (value) => ipcRenderer.invoke('desktop:set-api-base-url', value),
  getLanguage: () => ipcRenderer.invoke('desktop:get-language'),
  setLanguage: (value) => ipcRenderer.invoke('desktop:set-language', value),
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
