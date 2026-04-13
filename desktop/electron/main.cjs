const path = require('node:path')

const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, screen } = require('electron')

let store
let petWindow
let quickChatWindow
let mainPanelWindow
let tray
let quitting = false

const isDev = !app.isPackaged
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const defaultApiBaseUrl =
  process.env.DETACHYM_API_BASE_URL ||
  process.env.VITE_API_BASE_URL ||
  (isDev ? 'http://127.0.0.1:5000/api/v1' : '')

const DEFAULT_LANGUAGE = 'zh-CN'
const PET_WINDOW_WIDTH = 220
const PET_WINDOW_HEIGHT = 240
const PET_VISIBLE_WIDTH = 126
const PET_VISIBLE_HEIGHT = 148

const trayMessages = {
  'zh-CN': {
    trayTooltip: 'Detachym 桌宠',
    openMainPanel: '打开主面板',
    toggleQuickChat: '切换快捷聊天',
    autoLaunch: '开机启动',
    muteNotifications: '静音通知',
    quit: '退出',
  },
  en: {
    trayTooltip: 'Detachym Desktop Pet',
    openMainPanel: 'Open Main Panel',
    toggleQuickChat: 'Toggle Quick Chat',
    autoLaunch: 'Launch at Startup',
    muteNotifications: 'Mute Notifications',
    quit: 'Quit',
  },
}

function getAssetPath(fileName) {
  return path.join(__dirname, '..', fileName)
}

function getWindowIconPath() {
  return getAssetPath(path.join('build', 'icon.ico'))
}

function normalizeLanguage(value) {
  const normalizedValue = String(value || '').trim().toLowerCase()
  if (normalizedValue.startsWith('zh')) {
    return 'zh-CN'
  }
  if (normalizedValue.startsWith('en')) {
    return 'en'
  }
  return DEFAULT_LANGUAGE
}

function getLanguageMessages() {
  return trayMessages[normalizeLanguage(getStore().get('language'))] || trayMessages[DEFAULT_LANGUAGE]
}

function getTrayIcon() {
  const trayIcon = nativeImage.createFromPath(getAssetPath(path.join('build', 'icon.png')))
  if (!trayIcon.isEmpty()) {
    return trayIcon.resize({ width: 20, height: 20 })
  }

  return createTrayIconFallback()
}

async function createStore() {
  const { default: Store } = await import('electron-store')
  return new Store({
    defaults: {
      petBounds: { width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT, x: 90, y: 90 },
      quickBounds: { width: 400, height: 560 },
      mainBounds: { width: 1100, height: 780 },
      autoLaunch: false,
      mute: false,
      apiBaseUrl: defaultApiBaseUrl,
      sessionToken: null,
      language: DEFAULT_LANGUAGE,
    },
  })
}

function getStore() {
  if (!store) {
    throw new Error('Store has not been initialized')
  }
  return store
}

function getPetBounds() {
  const petBounds = getStore().get('petBounds')
  return {
    width: Math.max(PET_WINDOW_WIDTH, petBounds.width || 0),
    height: Math.max(PET_WINDOW_HEIGHT, petBounds.height || 0),
    x: petBounds.x,
    y: petBounds.y,
  }
}

function createTrayIconFallback() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#38bdf8" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="url(#g)" />
      <circle cx="25" cy="28" r="4" fill="#fff" />
      <circle cx="39" cy="28" r="4" fill="#fff" />
      <path d="M24 42c3 3 13 3 16 0" stroke="#fff" stroke-width="4" stroke-linecap="round" fill="none" />
    </svg>
  `
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

function getRendererEntry(fileName) {
  if (isDev && rendererUrl) {
    return `${rendererUrl}/${fileName}`
  }
  return path.join(__dirname, '..', 'dist', 'renderer', fileName)
}

async function loadWindow(window, fileName) {
  if (isDev && rendererUrl) {
    await window.loadURL(getRendererEntry(fileName))
    return
  }
  await window.loadFile(getRendererEntry(fileName))
}

function persistBounds(key, window, options = { saveSize: true }) {
  const save = () => {
    if (!window || window.isDestroyed()) {
      return
    }

    const bounds = window.getBounds()
    const nextValue = options.saveSize
      ? bounds
      : { ...getStore().get(key), x: bounds.x, y: bounds.y }
    getStore().set(key, nextValue)
  }

  window.on('move', save)
  window.on('resize', save)
}

function clampPetPosition(x, y, width, height) {
  const point = {
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
  }
  const display = screen.getDisplayNearestPoint(point)
  const workArea = display.workArea

  return {
    x: Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - height),
  }
}

function setPetPosition(x, y) {
  if (!petWindow || petWindow.isDestroyed()) {
    return null
  }

  const currentBounds = petWindow.getBounds()
  const nextPosition = clampPetPosition(x, y, currentBounds.width, currentBounds.height)
  petWindow.setPosition(nextPosition.x, nextPosition.y)
  getStore().set('petBounds', { ...getStore().get('petBounds'), x: nextPosition.x, y: nextPosition.y })
  return nextPosition
}

function createPetWindow() {
  const petBounds = getPetBounds()
  petWindow = new BrowserWindow({
    ...petBounds,
    icon: getWindowIconPath(),
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  petWindow.setAlwaysOnTop(true, 'screen-saver')
  persistBounds('petBounds', petWindow, { saveSize: false })
  petWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      petWindow.hide()
    }
  })

  loadWindow(petWindow, 'pet.html')
}

function createQuickChatWindow() {
  const quickBounds = getStore().get('quickBounds')
  quickChatWindow = new BrowserWindow({
    ...quickBounds,
    icon: getWindowIconPath(),
    show: false,
    frame: false,
    resizable: true,
    fullscreenable: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  persistBounds('quickBounds', quickChatWindow)
  quickChatWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      quickChatWindow.hide()
    }
  })

  loadWindow(quickChatWindow, 'quick-chat.html')
}

function createMainPanelWindow() {
  const mainBounds = getStore().get('mainBounds')
  mainPanelWindow = new BrowserWindow({
    ...mainBounds,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  persistBounds('mainBounds', mainPanelWindow)
  mainPanelWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainPanelWindow.hide()
    }
  })

  loadWindow(mainPanelWindow, 'main-panel.html')
}

function toggleQuickChat() {
  if (!quickChatWindow || !petWindow) {
    return false
  }

  if (quickChatWindow.isVisible()) {
    quickChatWindow.hide()
    return false
  }

  const petBounds = petWindow.getBounds()
  const quickBounds = quickChatWindow.getBounds()
  const quickChatX = petBounds.x + Math.round((petBounds.width + PET_VISIBLE_WIDTH) / 2) + 12
  const quickChatY = petBounds.y + petBounds.height - PET_VISIBLE_HEIGHT

  quickChatWindow.setPosition(quickChatX, quickChatY)
  quickChatWindow.setSize(quickBounds.width, quickBounds.height)
  quickChatWindow.show()
  quickChatWindow.focus()
  return true
}

function openMainPanel() {
  if (!mainPanelWindow) {
    return false
  }

  mainPanelWindow.show()
  mainPanelWindow.focus()
  return true
}

function buildTrayMenu() {
  const messages = getLanguageMessages()

  return Menu.buildFromTemplate([
    { label: messages.openMainPanel, click: openMainPanel },
    { label: messages.toggleQuickChat, click: toggleQuickChat },
    {
      label: messages.autoLaunch,
      type: 'checkbox',
      checked: Boolean(getStore().get('autoLaunch')),
      click: ({ checked }) => {
        getStore().set('autoLaunch', checked)
        app.setLoginItemSettings({ openAtLogin: checked })
      },
    },
    {
      label: messages.muteNotifications,
      type: 'checkbox',
      checked: Boolean(getStore().get('mute')),
      click: ({ checked }) => {
        getStore().set('mute', checked)
      },
    },
    { type: 'separator' },
    {
      label: messages.quit,
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  tray = new Tray(getTrayIcon())
  tray.setToolTip(getLanguageMessages().trayTooltip)
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', openMainPanel)
}

function refreshTray() {
  if (!tray) {
    return
  }

  tray.setToolTip(getLanguageMessages().trayTooltip)
  tray.setContextMenu(buildTrayMenu())
}

function registerIpc() {
  ipcMain.handle('desktop:open-main-panel', async () => openMainPanel())
  ipcMain.handle('desktop:toggle-quick-chat', async () => toggleQuickChat())

  ipcMain.handle('desktop:toggle-auto-launch', async (_event, enabled) => {
    getStore().set('autoLaunch', enabled)
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
    return Boolean(enabled)
  })

  ipcMain.handle('desktop:get-app-version', async () => app.getVersion())
  ipcMain.handle('desktop:get-api-base-url', async () => getStore().get('apiBaseUrl'))
  ipcMain.handle('desktop:set-api-base-url', async (_event, value) => {
    getStore().set('apiBaseUrl', value)
    return value
  })
  ipcMain.handle('desktop:get-language', async () => normalizeLanguage(getStore().get('language')))
  ipcMain.handle('desktop:set-language', async (_event, value) => {
    const nextLanguage = normalizeLanguage(value)
    getStore().set('language', nextLanguage)
    refreshTray()
    return nextLanguage
  })
  ipcMain.handle('desktop:get-pet-bounds', async () => {
    if (!petWindow || petWindow.isDestroyed()) {
      return getPetBounds()
    }
    return petWindow.getBounds()
  })
  ipcMain.handle('desktop:set-pet-position', async (_event, position) => {
    if (!position || typeof position !== 'object') {
      return null
    }
    return setPetPosition(position.x, position.y)
  })

  ipcMain.handle('desktop:show-notification', async (_event, payload) => {
    if (getStore().get('mute')) {
      return false
    }

    const notification = new Notification({
      title: payload?.title || 'Detachym',
      body: payload?.body || '',
    })
    notification.show()
    return true
  })

  ipcMain.handle('desktop:get-session-token', async () => getStore().get('sessionToken'))
  ipcMain.handle('desktop:set-session-token', async (_event, token) => {
    getStore().set('sessionToken', token)
    return true
  })
  ipcMain.handle('desktop:clear-session-token', async () => {
    getStore().set('sessionToken', null)
    return true
  })
}

function bootstrap() {
  createPetWindow()
  createQuickChatWindow()
  createMainPanelWindow()
  createTray()
  registerIpc()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (petWindow) {
      petWindow.show()
      petWindow.focus()
    }
    openMainPanel()
  })

  app.whenReady().then(async () => {
    store = await createStore()
    app.setLoginItemSettings({ openAtLogin: Boolean(getStore().get('autoLaunch')) })
    bootstrap()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      bootstrap()
    }
  })

  app.on('before-quit', () => {
    quitting = true
  })
}
