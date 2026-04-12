const path = require('node:path')

const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage } = require('electron')

let store
let petWindow
let quickChatWindow
let mainPanelWindow
let tray
let quitting = false

const isDev = !app.isPackaged
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const defaultApiBaseUrl = process.env.DETACHYM_API_BASE_URL || process.env.VITE_API_BASE_URL || (isDev ? 'http://127.0.0.1:5000/api/v1' : '')

function getAssetPath(fileName) {
  return path.join(__dirname, '..', fileName)
}

function getWindowIconPath() {
  return getAssetPath(path.join('build', 'icon.ico'))
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
      petBounds: { width: 156, height: 176, x: 90, y: 90 },
      quickBounds: { width: 400, height: 560 },
      mainBounds: { width: 1100, height: 780 },
      autoLaunch: false,
      mute: false,
      apiBaseUrl: defaultApiBaseUrl,
      sessionToken: null,
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
    width: Math.max(156, petBounds.width || 0),
    height: Math.max(176, petBounds.height || 0),
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
    return
  }

  if (quickChatWindow.isVisible()) {
    quickChatWindow.hide()
    return
  }

  const petBounds = petWindow.getBounds()
  const quickBounds = quickChatWindow.getBounds()
  quickChatWindow.setPosition(petBounds.x + petBounds.width + 12, petBounds.y)
  quickChatWindow.setSize(quickBounds.width, quickBounds.height)
  quickChatWindow.show()
  quickChatWindow.focus()
}

function openMainPanel() {
  if (!mainPanelWindow) {
    return
  }

  mainPanelWindow.show()
  mainPanelWindow.focus()
}

function createTray() {
  tray = new Tray(getTrayIcon())
  tray.setToolTip('Detachym Desktop Pet')

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: '打开主面板', click: openMainPanel },
      { label: '切换快捷聊天', click: toggleQuickChat },
      {
        label: '开机启动',
        type: 'checkbox',
        checked: Boolean(getStore().get('autoLaunch')),
        click: ({ checked }) => {
          getStore().set('autoLaunch', checked)
          app.setLoginItemSettings({ openAtLogin: checked })
        },
      },
      {
        label: '静音通知',
        type: 'checkbox',
        checked: Boolean(getStore().get('mute')),
        click: ({ checked }) => {
          getStore().set('mute', checked)
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])

  tray.setContextMenu(buildMenu())
  tray.on('double-click', openMainPanel)
}

function registerIpc() {
  ipcMain.handle('desktop:open-main-panel', async () => {
    openMainPanel()
    return true
  })

  ipcMain.handle('desktop:toggle-quick-chat', async () => {
    toggleQuickChat()
    return true
  })

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
