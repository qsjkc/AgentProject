const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  openMainPanel: () => ipcRenderer.invoke('desktop:open-main-panel'),
  toggleQuickChat: () => ipcRenderer.invoke('desktop:toggle-quick-chat'),
  toggleAutoLaunch: (enabled) => ipcRenderer.invoke('desktop:toggle-auto-launch', enabled),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  showNotification: (payload) => ipcRenderer.invoke('desktop:show-notification', payload),
  getApiBaseUrl: () => ipcRenderer.invoke('desktop:get-api-base-url'),
  setApiBaseUrl: (value) => ipcRenderer.invoke('desktop:set-api-base-url', value),
  getSessionToken: () => ipcRenderer.invoke('desktop:get-session-token'),
  setSessionToken: (token) => ipcRenderer.invoke('desktop:set-session-token', token),
  clearSessionToken: () => ipcRenderer.invoke('desktop:clear-session-token'),
})
