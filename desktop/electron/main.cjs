const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const {
  clearPetMilestonePlaybackEntry,
  clearPetMilestonePlaybackSnapshot,
  readPetMilestonePlaybackEntry,
  setPetMilestonePlaybackEntry,
} = require('./pet-milestone-playback-store.cjs')

const {
  PET_ONBOARDING_CAPABILITIES,
  ackPetOnboardingPresentation: ackPetOnboardingPresentationState,
  calculatePetOnboardingEngagementSample,
  claimPetOnboardingPresentation: claimPetOnboardingPresentationState,
  createPetOnboardingKey,
  createPetOnboardingState,
  dismissPetOnboarding: dismissPetOnboardingState,
  normalizePetOnboardingContext,
  readPetOnboardingEntry,
  recordPetOnboardingEngagement: recordPetOnboardingEngagementState,
  recordPetOnboardingObservation: recordPetOnboardingObservationState,
  releasePetOnboardingPresentation: releasePetOnboardingPresentationState,
  snoozePetOnboarding: snoozePetOnboardingState,
} = require('./pet-onboarding-store.cjs')
const {
  projectPetOnboardingStateForRole,
} = require('./pet-onboarding-dto.cjs')
const {
  createPetOnboardingStateBroadcaster,
} = require('./pet-onboarding-broadcast.cjs')
const {
  createRendererHeartbeatRecord,
  createRendererTelemetryRecord,
} = require('./renderer-telemetry.cjs')
const {
  authorizeAccountMutation,
  authorizeNotification,
  authorizeSessionClear,
  authorizeSwitchPet,
  createAuthoritativeOperationContextState,
  createOperationCapabilityRegistry,
  createRelationshipBroadcastOrchestrator,
  createRuntimeStateForRole,
  createStableAccountContextKey,
  isExactSessionSnapshot,
} = require('./account-boundary.cjs')
const { createMainPanelIntentCoordinator } = require('./main-panel-intent.cjs')

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  nativeImage,
  powerMonitor,
  screen,
} = require('electron')

let store
let petWindow
let quickChatWindow
let mainPanelWindow
let tray
let quitting = false
let debugLogPath = null
let registeredVoiceGlobalShortcut = null
let mainPanelIntentCoordinator = null
let sessionGeneration = 0
const authoritativeOperationContext = createAuthoritativeOperationContextState()
const operationCapabilities = createOperationCapabilityRegistry({
  authoritativeState: authoritativeOperationContext,
  createId: randomUUID,
})
let relationshipBroadcastOrchestrator = null
let petOnboardingStateBroadcaster = null

const rendererHeartbeatState = Object.create(null)
const petOnboardingEngagementSamples = new Map()
const isDev = !app.isPackaged
const isE2e = isDev && process.env.DETACHYM_E2E === '1'
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const defaultApiBaseUrl =
  process.env.DETACHYM_API_BASE_URL ||
  process.env.VITE_API_BASE_URL ||
  (isDev ? 'http://127.0.0.1:5000/api/v1' : '')

const DEFAULT_LANGUAGE = 'zh-CN'
const PET_TYPES = ['cat', 'dog', 'pig']
const VOICE_OUTPUT_MODES = ['text_only', 'voice_and_text']
const DEFAULT_VOICE_SETTINGS = {
  desktop_voice_enabled: true,
  desktop_voice_trigger_key: 'KeyD',
  desktop_voice_global_shortcut: 'CommandOrControl+Alt+D',
  desktop_voice_idle_timeout_seconds: 8,
  desktop_voice_output_mode: 'voice_and_text',
}
const COMPANION_MODES = ['off', 'low', 'standard']
const DEFAULT_COMPANION_SETTINGS = {
  mode: 'standard',
  quietHoursStart: 23,
  quietHoursEnd: 8,
}
const VOICE_SETTINGS_OUTPUT_MIGRATION_KEY = 'voiceSettingsOutputModeMigratedAt'
const PET_WINDOW_WIDTH = 220
const PET_WINDOW_HEIGHT = 240
const PET_VISIBLE_WIDTH = 126
const PET_VISIBLE_HEIGHT = 148
const QUICK_CHAT_WIDTH = 430
const QUICK_CHAT_HEIGHT = 420
const MAIN_PANEL_WIDTH = 1100
const MAIN_PANEL_HEIGHT = 780
const MAIN_PANEL_INTENT_READY_TIMEOUT_MS = 5000
const E2E_PROTOCOL_VERSION = 1
const e2eRuntime = {
  intentSequence: 0,
  intent: { contextUserId: null, lastResult: null },
  lastCompletedRequest: null,
  activityJournal: [],
}

const trayMessages = {
  'zh-CN': {
    trayTooltip: 'Detachym 桌宠',
    showPet: '显示桌宠',
    resetPetPosition: '重置桌宠位置',
    openMainPanel: '打开主面板',
    toggleQuickChat: '切换快捷聊天',
    autoLaunch: '开机启动',
    muteNotifications: '静音通知',
    quit: '退出',
  },
  en: {
    trayTooltip: 'Detachym Desktop Pet',
    showPet: 'Show Desktop Pet',
    resetPetPosition: 'Reset Pet Position',
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

function normalizePetType(value) {
  const normalizedValue = String(value || '').trim().toLowerCase()
  return PET_TYPES.includes(normalizedValue) ? normalizedValue : 'cat'
}

function normalizeVoiceSettings(value = {}) {
  const outputMode = VOICE_OUTPUT_MODES.includes(value.desktop_voice_output_mode)
    ? value.desktop_voice_output_mode
    : DEFAULT_VOICE_SETTINGS.desktop_voice_output_mode
  const globalShortcutValue =
    typeof value.desktop_voice_global_shortcut === 'string' && value.desktop_voice_global_shortcut.trim()
      ? value.desktop_voice_global_shortcut.trim()
      : DEFAULT_VOICE_SETTINGS.desktop_voice_global_shortcut

  return {
    desktop_voice_enabled: value.desktop_voice_enabled ?? DEFAULT_VOICE_SETTINGS.desktop_voice_enabled,
    desktop_voice_trigger_key:
      value.desktop_voice_trigger_key || DEFAULT_VOICE_SETTINGS.desktop_voice_trigger_key,
    desktop_voice_global_shortcut: globalShortcutValue,
    desktop_voice_idle_timeout_seconds: Math.max(
      3,
      Number(value.desktop_voice_idle_timeout_seconds) || DEFAULT_VOICE_SETTINGS.desktop_voice_idle_timeout_seconds,
    ),
    desktop_voice_output_mode: outputMode,
  }
}

function normalizeCompanionHour(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(23, Math.max(0, Math.round(number)))
}

function normalizeCompanionSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    mode: COMPANION_MODES.includes(source.mode)
      ? source.mode
      : DEFAULT_COMPANION_SETTINGS.mode,
    quietHoursStart: normalizeCompanionHour(
      source.quietHoursStart,
      DEFAULT_COMPANION_SETTINGS.quietHoursStart,
    ),
    quietHoursEnd: normalizeCompanionHour(
      source.quietHoursEnd,
      DEFAULT_COMPANION_SETTINGS.quietHoursEnd,
    ),
  }
}

function getLanguageMessages() {
  const language = normalizeLanguage(getStore().get('language'))
  return trayMessages[language] || trayMessages[DEFAULT_LANGUAGE]
}

function getWindowTitle(kind) {
  const language = normalizeLanguage(getStore().get('language'))
  const englishTitles = {
    quickChat: 'Detachym Quick Chat',
    mainPanel: 'Detachym Desktop Client',
  }
  const chineseTitles = {
    quickChat: 'Detachym 快捷聊天',
    mainPanel: 'Detachym 桌宠客户端',
  }

  return (language === 'zh-CN' ? chineseTitles : englishTitles)[kind] || 'Detachym'
}

function ensureDebugLogPath() {
  if (debugLogPath) {
    return debugLogPath
  }

  const baseDir = process.env.APPDATA || process.env.LOCALAPPDATA || process.env.TEMP || process.cwd()
  const logDir = isE2e
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(baseDir, 'Detachym', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  debugLogPath = path.join(logDir, `desktop-main-${stamp}-${process.pid}.log`)
  return debugLogPath
}

function logDesktop(event, details = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details,
  })

  try {
    fs.appendFileSync(ensureDebugLogPath(), `${line}\n`)
  } catch {
    // best effort only
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
      petState: {
        petType: 'cat',
        hasSession: false,
        userId: null,
        language: DEFAULT_LANGUAGE,
        preferences: {
          pet_type: 'cat',
          quick_chat_enabled: true,
          bubble_frequency: 120,
        },
      },
      petRelationshipCache: {},
      petMilestonePlayback: {},
      petOnboardingStates: {},
      petCompanionSettings: DEFAULT_COMPANION_SETTINGS,
      petCompanionState: {},
      quickBounds: { width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT },
      mainBounds: { width: MAIN_PANEL_WIDTH, height: MAIN_PANEL_HEIGHT },
      voiceSettings: DEFAULT_VOICE_SETTINGS,
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

function normalizeUserId(value) {
  const numericValue = Number(value)
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null
}

function getUnverifiedJwtSubject(token) {
  if (typeof token !== 'string') {
    return null
  }
  const segments = token.split('.')
  if (segments.length !== 3) {
    return null
  }
  try {
    // This is only a consistency hint for renderer IPC payloads. The API server,
    // not this unverified decode, remains the authentication authority.
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    return normalizeUserId(payload?.sub)
  } catch {
    return null
  }
}

function getCurrentSessionSubject() {
  return getUnverifiedJwtSubject(getStore().get('sessionToken'))
}

function getCurrentStableAccountContext() {
  const petState = getPetState()
  const sessionSubject = getCurrentSessionSubject()
  const hasStableAccount = Boolean(
    petState.hasSession
    && sessionSubject !== null
    && petState.userId === sessionSubject
  )
  const relationship = getCachedPetRelationship(petState.petType)
  const relationshipUserId = normalizeUserId(
    relationship?.user_id ?? relationship?.userId,
  )
  return {
    hasSession: hasStableAccount,
    userId: hasStableAccount ? sessionSubject : null,
    petType: petState.petType,
    session: getCurrentSessionSnapshot(),
    relationshipId: (
      hasStableAccount
      && relationshipUserId === sessionSubject
      && relationship?.pet_type === petState.petType
    )
      ? normalizeUserId(relationship.id)
      : null,
  }
}

function observeAuthoritativeOperationContext(options = {}) {
  return authoritativeOperationContext.observe(getCurrentStableAccountContext(), options)
}

function registerRendererInstanceForEvent(event, rendererInstanceNonce) {
  const senderRole = getIpcSenderRole(event)
  const registered = operationCapabilities.registerRendererInstance({
    sender: event?.sender,
    senderRole,
    rendererInstanceNonce,
  })
  if (!registered || senderRole !== 'main-panel') return registered

  const coordinator = getMainPanelIntentCoordinator()
  const pending = coordinator.getPendingMetadata()
  if (!pending) return true
  const currentContext = getCurrentStableAccountContext()
  const semantic = pending.semantic
  const sameIdentity = Boolean(
    semantic
    && normalizeUserId(semantic.userId) === currentContext.userId
    && semantic.petType === currentContext.petType
    && normalizeUserId(semantic.relationshipId) === currentContext.relationshipId
  )
  const reboundCapability = sameIdentity
    ? issueTrustedOperationCapabilityForWindow(mainPanelWindow, 'relationship', currentContext)
    : null
  if (!reboundCapability || !coordinator.rebindPendingContext(reboundCapability)) {
    coordinator.failPending('renderer-instance-rebind-failed')
  }
  return true
}

function captureAuthoritativeOperationContextForRenderer(
  event,
  scope = 'pet',
  expectedContext = null,
  rendererInstanceNonce = null,
) {
  if (expectedContext?.authoritative) return null
  if (!operationCapabilities.isRendererInstanceCurrent({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    rendererInstanceNonce,
  })) return null
  return operationCapabilities.issue({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    rendererInstanceNonce,
    scope,
    currentContext: getCurrentStableAccountContext(),
    expectedContext,
  })
}

function renewAuthoritativeOperationContextForRenderer(
  event,
  capability,
  requiredScope,
  semantic,
  rendererInstanceNonce,
) {
  if (!operationCapabilities.isRendererInstanceCurrent({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    rendererInstanceNonce,
  })) return null
  return operationCapabilities.renew({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    rendererInstanceNonce,
    capability,
    requiredScope,
    currentContext: getCurrentStableAccountContext(),
    expectedSemantic: semantic,
  })
}

function validateAuthoritativeOperationContextForRenderer(
  event,
  snapshot,
  requiredScope,
  semantic,
  rendererInstanceNonce,
) {
  if (!operationCapabilities.isRendererInstanceCurrent({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    rendererInstanceNonce,
  })) return false
  return operationCapabilities.authorize({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    capability: snapshot,
    requiredScope,
    expectedSemantic: semantic,
    currentContext: getCurrentStableAccountContext(),
  }).ok
}

function authorizeRendererAccountMutation(
  event,
  expectedContext,
  allowedRoles,
  { requireRelationship = false, requiredScope = null } = {},
) {
  const capabilityAuthorization = operationCapabilities.authorize({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    capability: expectedContext?.authoritative,
    requiredScope,
    currentContext: getCurrentStableAccountContext(),
  })
  if (!requiredScope || !capabilityAuthorization.ok) {
    return capabilityAuthorization.ok
      ? { ok: false, reason: 'required-scope-missing' }
      : capabilityAuthorization
  }
  const authorization = authorizeAccountMutation({
    senderRole: getIpcSenderRole(event),
    allowedRoles,
    expectedContext,
    currentContext: getCurrentStableAccountContext(),
    requireRelationship,
  })
  if (!authorization.ok) {
    return authorization
  }
  return authorization
}

function getMainPanelIntentCoordinator() {
  if (!mainPanelIntentCoordinator) {
    mainPanelIntentCoordinator = createMainPanelIntentCoordinator({
      timeoutMs: MAIN_PANEL_INTENT_READY_TIMEOUT_MS,
      deliver: (payload) => {
        if (!mainPanelWindow || mainPanelWindow.isDestroyed()) {
          return false
        }
        mainPanelWindow.webContents.send('desktop:main-panel-intent', payload)
        return true
      },
      validateContext: (context) => operationCapabilities.validate({
        sender: mainPanelWindow?.webContents,
        senderRole: 'main-panel',
        rendererInstanceNonce: operationCapabilities.getRendererInstanceNonce(
          mainPanelWindow?.webContents,
        ),
        capability: context,
        currentContext: getCurrentStableAccountContext(),
      }).ok,
    })
  }
  return mainPanelIntentCoordinator
}

function resetPetOnboardingEngagementSamples() {
  petOnboardingEngagementSamples.clear()
}

function clearAccountScopedPetContext() {
  getStore().set('petRelationshipCache', {})
  getStore().set('petMilestonePlayback', {})
  getStore().set('petCompanionState', {})
  resetPetOnboardingEngagementSamples()
  observeAuthoritativeOperationContext()
  for (const windowInstance of [petWindow, quickChatWindow, mainPanelWindow]) {
    sendPetRelationshipToWindow(windowInstance, null)
    sendCompanionStateToWindow(windowInstance, {
      pet_type: null,
      state: null,
      cleared: true,
    })
  }
}

function getRendererEntry(fileName) {
  if (isDev && rendererUrl) {
    return `${rendererUrl}/${fileName}`
  }
  return path.join(__dirname, '..', 'dist', 'renderer', fileName)
}

function getRendererEntryUrl(fileName) {
  const entry = getRendererEntry(fileName)
  return isDev && rendererUrl ? new URL(entry).href : pathToFileURL(entry).href
}

function attachRendererNavigationGuard(windowInstance, fileName) {
  const sender = windowInstance?.webContents
  if (!sender) return
  const allowedUrl = getRendererEntryUrl(fileName)
  const blockUnexpectedNavigation = (event, targetUrl) => {
    let normalizedTarget = null
    try {
      normalizedTarget = new URL(targetUrl).href
    } catch {
      // Invalid or non-URL navigation is never a renderer entry.
    }
    if (normalizedTarget === allowedUrl) return
    event.preventDefault()
    logDesktop('renderer-navigation-blocked', {
      role: windowInstance.__role,
      targetUrl: normalizedTarget || 'invalid',
    })
  }
  sender.setWindowOpenHandler(() => ({ action: 'deny' }))
  sender.on('will-navigate', blockUnexpectedNavigation)
  sender.on('will-redirect', blockUnexpectedNavigation)
}

async function loadWindow(windowInstance, fileName) {
  if (isDev && rendererUrl) {
    await windowInstance.loadURL(getRendererEntry(fileName))
    return
  }
  await windowInstance.loadFile(getRendererEntry(fileName))
}

function persistBounds(key, windowInstance, options = { saveSize: true }) {
  const save = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }

    const bounds = windowInstance.getBounds()
    const nextValue = options.saveSize
      ? bounds
      : { ...getStore().get(key), x: bounds.x, y: bounds.y }
    getStore().set(key, nextValue)
  }

  windowInstance.on('move', save)
  windowInstance.on('resize', save)
}

function clampWindowPosition(x, y, width, height, displayOverride = null) {
  const point = {
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
  }
  const display = displayOverride || screen.getDisplayNearestPoint(point)
  const workArea = display.workArea

  return {
    x: Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - height),
  }
}

function getPetBounds() {
  const petBounds = getStore().get('petBounds') || {}
  return {
    width: Math.max(PET_WINDOW_WIDTH, Number(petBounds.width) || 0),
    height: Math.max(PET_WINDOW_HEIGHT, Number(petBounds.height) || 0),
    x: Number.isFinite(petBounds.x) ? petBounds.x : 90,
    y: Number.isFinite(petBounds.y) ? petBounds.y : 90,
  }
}

function getPetState() {
  const petState = getStore().get('petState') || {}
  const preferences = petState.preferences || {}
  const petType = normalizePetType(petState.petType || preferences.pet_type || 'cat')
  return {
    petType,
    hasSession: Boolean(petState.hasSession),
    userId: Number.isInteger(petState.userId) && petState.userId > 0
      ? petState.userId
      : null,
    language: normalizeLanguage(petState.language || getStore().get('language')),
    preferences: {
      pet_type: petType,
      quick_chat_enabled: preferences.quick_chat_enabled ?? true,
      bubble_frequency: preferences.bubble_frequency ?? 120,
    },
  }
}

function getVoiceSettings() {
  return normalizeVoiceSettings(getStore().get('voiceSettings') || DEFAULT_VOICE_SETTINGS)
}

function getCompanionSettings() {
  return normalizeCompanionSettings(
    getStore().get('petCompanionSettings') || DEFAULT_COMPANION_SETTINGS,
  )
}

function getPetCompanionState(petType, accountUserId = null) {
  const normalizedPetType = normalizePetType(petType)
  const stateByPet = getStore().get('petCompanionState') || {}
  const storageKey = normalizeUserId(accountUserId) === null
    ? normalizedPetType
    : `${normalizeUserId(accountUserId)}:${normalizedPetType}`
  return stateByPet[storageKey] || null
}

function getCachedPetRelationship(petType) {
  const normalizedPetType = normalizePetType(petType)
  const cache = getStore().get('petRelationshipCache') || {}
  return cache[normalizedPetType] || null
}

function issueTrustedOperationCapabilityForWindow(windowInstance, scope, currentContext) {
  const sender = windowInstance?.webContents
  const rendererInstanceNonce = operationCapabilities.getRendererInstanceNonce(sender)
  if (!sender || !rendererInstanceNonce) return null
  return operationCapabilities.issueTrusted({
    sender,
    senderRole: windowInstance.__role,
    rendererInstanceNonce,
    scope,
    currentContext,
  })
}

function waitForRendererInstance(windowInstance, timeoutMs = MAIN_PANEL_INTENT_READY_TIMEOUT_MS) {
  const sender = windowInstance?.webContents
  if (!sender || sender.isDestroyed()) return Promise.resolve(false)
  if (operationCapabilities.getRendererInstanceNonce(sender)) return Promise.resolve(true)

  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0)
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let timer = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      sender.removeListener('destroyed', handleUnavailable)
      sender.removeListener('render-process-gone', handleUnavailable)
      resolve(value)
    }
    const handleUnavailable = () => finish(false)
    const check = () => {
      if (sender.isDestroyed()) {
        finish(false)
        return
      }
      if (operationCapabilities.getRendererInstanceNonce(sender)) {
        finish(true)
        return
      }
      if (Date.now() - startedAt >= boundedTimeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, 10)
    }
    sender.once('destroyed', handleUnavailable)
    sender.once('render-process-gone', handleUnavailable)
    check()
  })
}

function sendPetRelationshipToWindow(windowInstance, relationship) {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return
  }

  if (!relationshipBroadcastOrchestrator) {
    relationshipBroadcastOrchestrator = createRelationshipBroadcastOrchestrator({
      getCurrentRelationship: () => getCachedPetRelationship(getPetState().petType),
      getCurrentContext: getCurrentStableAccountContext,
      issueCapability: ({ target, currentContext }) => (
        issueTrustedOperationCapabilityForWindow(target, 'relationship', currentContext)
      ),
      send: (target, payload) => {
        if (!target.isDestroyed()) {
          target.webContents.send('desktop:pet-relationship-changed', payload)
        }
      },
    })
  }

  const emit = relationshipBroadcastOrchestrator.createDeferredEmit(windowInstance)
  const guardedEmit = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }
    if (relationship === null || relationship === undefined) {
      windowInstance.webContents.send('desktop:pet-relationship-changed', null)
      return
    }
    emit()
  }

  if (windowInstance.webContents.isLoading()) {
    windowInstance.webContents.once('did-finish-load', guardedEmit)
    return
  }

  guardedEmit()
}

function cachePetRelationship(payload = {}) {
  const petType = normalizePetType(payload.pet_type || payload.petType)
  const cache = getStore().get('petRelationshipCache') || {}
  const previousRelationship = cache[petType] || null
  const nextRelationship = {
    ...payload,
    pet_type: petType,
    cached_at: new Date().toISOString(),
  }
  getStore().set('petRelationshipCache', {
    ...cache,
    [petType]: nextRelationship,
  })
  observeAuthoritativeOperationContext({ forceRelationshipRevision: true })
  if (
    normalizeUserId(previousRelationship?.id) !== normalizeUserId(nextRelationship.id)
    || normalizeUserId(previousRelationship?.user_id ?? previousRelationship?.userId)
      !== normalizeUserId(nextRelationship.user_id ?? nextRelationship.userId)
  ) {
    resetPetOnboardingEngagementSamples()
  }
  sendPetRelationshipToWindow(petWindow, nextRelationship)
  sendPetRelationshipToWindow(quickChatWindow, nextRelationship)
  sendPetRelationshipToWindow(mainPanelWindow, nextRelationship)
  broadcastPetOnboardingState()
  return nextRelationship
}

function cachePetRelationshipForRenderer(event, payload = {}, expectedContext = null) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet', 'quick-chat', 'main-panel'],
    { requiredScope: 'pet' },
  )
  if (!authorization.ok) {
    return authorization
  }
  const activeState = getPetState()
  const sessionSubject = getCurrentSessionSubject()
  const relationshipUserId = normalizeUserId(payload?.user_id ?? payload?.userId)
  const rawPetType = payload?.pet_type ?? payload?.petType
  if (
    sessionSubject === null
    || activeState.userId !== sessionSubject
    || relationshipUserId !== sessionSubject
  ) {
    return { ok: false, reason: 'identity-mismatch' }
  }
  if (!PET_TYPES.includes(rawPetType) || rawPetType !== activeState.petType) {
    return { ok: false, reason: 'pet-mismatch' }
  }
  const transition = operationCapabilities.transition({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    capability: expectedContext?.authoritative,
    requiredScope: 'pet',
    currentContext: getCurrentStableAccountContext(),
    nextScope: 'relationship',
    apply: () => cachePetRelationship(payload),
    getCurrentContext: getCurrentStableAccountContext,
  })
  if (!transition.ok) return transition
  return {
    ok: true,
    relationship: transition.value,
    authoritative: transition.capability,
  }
}

function getCachedPetRelationshipForRenderer(event, petType, expectedContext = null) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet', 'quick-chat', 'main-panel'],
    { requiredScope: 'pet' },
  )
  if (!authorization.ok) {
    return null
  }
  const activeState = getPetState()
  const sessionSubject = getCurrentSessionSubject()
  if (
    !PET_TYPES.includes(petType)
    || petType !== activeState.petType
    || sessionSubject === null
    || activeState.userId !== sessionSubject
  ) {
    return null
  }
  const relationship = getCachedPetRelationship(petType)
  return normalizeUserId(relationship?.user_id ?? relationship?.userId) === sessionSubject
    ? relationship
    : null
}

function getPetOnboardingContext() {
  const petState = getPetState()
  const relationship = getCachedPetRelationship('pig')
  const sessionSubject = getCurrentSessionSubject()
  return normalizePetOnboardingContext({
    has_session: (
      sessionSubject !== null
      && sessionSubject === petState.userId
      && petState.hasSession
    ),
    user_id: petState.userId,
    pet_type: petState.petType,
    relationship,
  })
}

function loadPetOnboardingState({ createIfEligible = true } = {}) {
  const context = getPetOnboardingContext()
  if (!context) {
    return {
      state: null,
      states: getStore().get('petOnboardingStates'),
      changed: false,
      reason: 'unavailable',
      context: null,
    }
  }
  const result = readPetOnboardingEntry({
    states: getStore().get('petOnboardingStates'),
    context,
    now: new Date(),
    createIfEligible,
  })
  if (result.changed) {
    getStore().set('petOnboardingStates', result.states)
  }
  return { ...result, context }
}

function getPetOnboardingStateBroadcaster() {
  if (!petOnboardingStateBroadcaster) {
    petOnboardingStateBroadcaster = createPetOnboardingStateBroadcaster({
      getCurrentState: () => loadPetOnboardingState().state,
      projectStateForRole: projectPetOnboardingStateForRole,
      send: (windowInstance, state) => {
        windowInstance.webContents.send('desktop:pet-onboarding-changed', state)
      },
    })
  }
  return petOnboardingStateBroadcaster
}

function sendPetOnboardingStateToWindow(windowInstance) {
  return getPetOnboardingStateBroadcaster().sendLatest(windowInstance)
}

function broadcastPetOnboardingState() {
  const { state } = loadPetOnboardingState()
  for (const windowInstance of [petWindow, mainPanelWindow]) {
    sendPetOnboardingStateToWindow(windowInstance)
  }
  return state
}

function isPetOnboardingPetTypeCurrent(petType) {
  const context = getPetOnboardingContext()
  return petType === 'pig' && context?.pet_type === petType
}

function getPetOnboardingStateForRenderer(event, petType, expectedContext) {
  const senderRole = getIpcSenderRole(event)
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet', 'main-panel'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  const loaded = loadPetOnboardingState()
  if (loaded.changed) {
    for (const windowInstance of [petWindow, mainPanelWindow]) {
      sendPetOnboardingStateToWindow(windowInstance)
    }
  }
  return {
    ok: true,
    state: projectPetOnboardingStateForRole(loaded.state, senderRole),
  }
}

function mutatePetOnboardingState(mutator, senderRole) {
  const loaded = loadPetOnboardingState()
  if (!loaded.context || !loaded.state) {
    return rejectedPetOnboardingMutation(loaded.reason || 'unavailable')
  }
  const result = mutator(loaded.state)
  if (!result || typeof result !== 'object') {
    return rejectedPetOnboardingMutation('invalid-mutation')
  }
  if (result.changed && result.state) {
    const key = createPetOnboardingKey(
      loaded.context.user_id,
      loaded.context.relationship_id,
    )
    getStore().set('petOnboardingStates', {
      ...loaded.states,
      [key]: result.state,
    })
    for (const windowInstance of [petWindow, mainPanelWindow]) {
      sendPetOnboardingStateToWindow(windowInstance)
    }
  } else if (loaded.changed) {
    for (const windowInstance of [petWindow, mainPanelWindow]) {
      sendPetOnboardingStateToWindow(windowInstance)
    }
  }
  if (!result.ok) {
    return rejectedPetOnboardingMutation(result.reason || 'mutation-rejected')
  }
  if (senderRole === 'quick-chat') {
    return { ok: true }
  }
  if (!['pet', 'main-panel'].includes(senderRole)) {
    return rejectedPetOnboardingMutation('forbidden')
  }
  return {
    ok: true,
    state: projectPetOnboardingStateForRole(result.state ?? loaded.state, senderRole),
  }
}

function getIpcSenderRole(event) {
  const sender = event?.sender
  if (petWindow && !petWindow.isDestroyed() && sender === petWindow.webContents) {
    return 'pet'
  }
  if (
    mainPanelWindow
    && !mainPanelWindow.isDestroyed()
    && sender === mainPanelWindow.webContents
  ) {
    return 'main-panel'
  }
  if (
    quickChatWindow
    && !quickChatWindow.isDestroyed()
    && sender === quickChatWindow.webContents
  ) {
    return 'quick-chat'
  }
  return null
}

function attachRendererCapabilityLifecycle(windowInstance) {
  const sender = windowInstance?.webContents
  if (!sender) return
  sender.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame !== false) operationCapabilities.revokeSender(sender)
  })
  sender.on('render-process-gone', () => {
    operationCapabilities.revokeSender(sender)
  })
  sender.once('destroyed', () => {
    operationCapabilities.revokeSender(sender)
  })
}

function rejectedPetOnboardingMutation(reason = 'forbidden') {
  return { ok: false, reason }
}

function recordPetOnboardingObservation(
  event,
  petType,
  capabilityId,
  payload = {},
  expectedContext = null,
) {
  const senderRole = getIpcSenderRole(event)
  const allowedRoles = {
    [PET_ONBOARDING_CAPABILITIES.PET_INTERACTION]: ['pet'],
    [PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED]: ['main-panel'],
    [PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED]: ['main-panel', 'quick-chat'],
    [PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED]: ['main-panel'],
  }
  if (!senderRole) {
    return rejectedPetOnboardingMutation('forbidden')
  }
  if (!allowedRoles[capabilityId]) {
    return rejectedPetOnboardingMutation('invalid-capability')
  }
  if (!allowedRoles[capabilityId].includes(senderRole)) {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    allowedRoles[capabilityId],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState((state) => (
    recordPetOnboardingObservationState(state, capabilityId, payload, new Date())
  ), senderRole)
}

function recordPetOnboardingEngagement(event, petType, deltaMs, expectedContext) {
  if (getIpcSenderRole(event) !== 'pet') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) {
    return rejectedPetOnboardingMutation('pet-not-visible')
  }
  let idleSeconds = Number.POSITIVE_INFINITY
  try {
    idleSeconds = isE2e ? 0 : powerMonitor.getSystemIdleTime()
  } catch {
    // Fail closed: engagement is only trusted while an active user is observable.
  }
  if (!Number.isFinite(idleSeconds) || idleSeconds >= 60) {
    return rejectedPetOnboardingMutation('system-idle')
  }
  const loaded = loadPetOnboardingState()
  if (!loaded.context || !loaded.state) {
    return rejectedPetOnboardingMutation(loaded.reason || 'unavailable')
  }
  if (loaded.changed) {
    for (const windowInstance of [petWindow, mainPanelWindow]) {
      sendPetOnboardingStateToWindow(windowInstance)
    }
  }
  const contextKey = createPetOnboardingKey(
    loaded.context.user_id,
    loaded.context.relationship_id,
  )
  const sampleResult = calculatePetOnboardingEngagementSample({
    previousSample: petOnboardingEngagementSamples.get(contextKey),
    contextKey,
    requestedDeltaMs: deltaMs,
    monotonicNowMs: performance.now(),
  })
  if (sampleResult.reason === 'invalid-sample') {
    return rejectedPetOnboardingMutation('invalid-delta')
  }
  petOnboardingEngagementSamples.set(contextKey, sampleResult.sample)
  if (sampleResult.acceptedDeltaMs <= 0) {
    return {
      ok: true,
      state: projectPetOnboardingStateForRole(loaded.state, 'pet'),
    }
  }
  return mutatePetOnboardingState((state) => (
    recordPetOnboardingEngagementState(
      state,
      sampleResult.acceptedDeltaMs,
      new Date(),
    )
  ), 'pet')
}

function claimPetOnboardingPresentation(event, petType, stepId, token, expectedContext) {
  if (getIpcSenderRole(event) !== 'pet') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState((state) => (
    claimPetOnboardingPresentationState(state, petType, stepId, token, new Date())
  ), 'pet')
}

function ackPetOnboardingPresentation(event, petType, stepId, token, expectedContext) {
  if (getIpcSenderRole(event) !== 'pet') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState((state) => (
    ackPetOnboardingPresentationState(state, petType, stepId, token, new Date())
  ), 'pet')
}

function releasePetOnboardingPresentation(event, petType, stepId, token, expectedContext) {
  if (getIpcSenderRole(event) !== 'pet') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState((state) => (
    releasePetOnboardingPresentationState(state, petType, stepId, token, new Date())
  ), 'pet')
}

function snoozePetOnboarding(event, petType, expectedContext) {
  if (getIpcSenderRole(event) !== 'main-panel') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['main-panel'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState(
    (state) => snoozePetOnboardingState(state, new Date()),
    'main-panel',
  )
}

function dismissPetOnboarding(event, petType, expectedContext) {
  if (getIpcSenderRole(event) !== 'main-panel') {
    return rejectedPetOnboardingMutation('forbidden')
  }
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['main-panel'],
    { requireRelationship: true, requiredScope: 'relationship' },
  )
  if (!authorization.ok) {
    return rejectedPetOnboardingMutation(authorization.reason)
  }
  if (!isPetOnboardingPetTypeCurrent(petType)) {
    return rejectedPetOnboardingMutation('invalid-pet')
  }
  return mutatePetOnboardingState(
    (state) => dismissPetOnboardingState(state, new Date()),
    'main-panel',
  )
}

function getPetMilestonePlaybackForRenderer(event, petType, expectedContext) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requiredScope: 'relationship' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (
    !authorization.ok
    || petType !== 'pig'
    || petType !== currentContext.petType
  ) {
    return null
  }
  const normalizedPetType = normalizePetType(petType)
  const storageKey = createStableAccountContextKey(currentContext)
  const playbackByPet = getStore().get('petMilestonePlayback') || {}
  const result = readPetMilestonePlaybackEntry(playbackByPet, normalizedPetType, {
    storageKey,
    accountUserId: currentContext.userId,
  })
  if (result.changed) {
    getStore().set('petMilestonePlayback', result.playbackByPet)
  }
  return result.playback
}

function setPetMilestonePlaybackForRenderer(
  event,
  petType,
  playback = {},
  expectedRevision = null,
  expectedContext = null,
) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requiredScope: 'relationship' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (
    !authorization.ok
    || petType !== 'pig'
    || petType !== currentContext.petType
  ) {
    return {
      ok: false,
      reason: authorization.ok ? 'pet-mismatch' : authorization.reason,
      current: null,
    }
  }
  const normalizedPetType = normalizePetType(petType)
  const storageKey = createStableAccountContextKey(currentContext)
  const playbackByPet = getStore().get('petMilestonePlayback') || {}
  if (!getStore().get('sessionToken')) {
    const current = readPetMilestonePlaybackEntry(
      playbackByPet,
      normalizedPetType,
      { storageKey, accountUserId: currentContext.userId },
    ).playback
    return { ok: false, reason: 'no-session', current }
  }
  const result = setPetMilestonePlaybackEntry({
    playbackByPet,
    petType: normalizedPetType,
    storageKey,
    accountUserId: currentContext.userId,
    playback,
    expectedRevision,
    updatedAt: new Date().toISOString(),
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason, current: result.current }
  }
  getStore().set('petMilestonePlayback', result.playbackByPet)
  return { ok: true, playback: result.playback }
}

function clearPetMilestonePlaybackForRenderer(
  event,
  petType,
  claimToken = '',
  expectedRevision = null,
  expectedContext = null,
) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requiredScope: 'relationship' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (
    !authorization.ok
    || petType !== 'pig'
    || petType !== currentContext.petType
  ) {
    return {
      ok: false,
      reason: authorization.ok ? 'pet-mismatch' : authorization.reason,
      current: null,
    }
  }
  const normalizedPetType = normalizePetType(petType)
  const storageKey = createStableAccountContextKey(currentContext)
  const playbackByPet = getStore().get('petMilestonePlayback') || {}
  const snapshot = readPetMilestonePlaybackEntry(playbackByPet, normalizedPetType, {
    storageKey,
    accountUserId: currentContext.userId,
  })
  if (snapshot.changed) {
    getStore().set('petMilestonePlayback', snapshot.playbackByPet)
  }
  if (!snapshot.playback) {
    return { ok: true, playback: null }
  }
  if (!getStore().get('sessionToken')) {
    return { ok: false, reason: 'no-session', current: snapshot.playback }
  }
  const result = clearPetMilestonePlaybackSnapshot({
    playbackByPet: snapshot.playbackByPet,
    petType: normalizedPetType,
    storageKey,
    accountUserId: currentContext.userId,
    claimToken,
    expectedRevision,
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason, current: result.current }
  }
  if (result.changed) {
    getStore().set('petMilestonePlayback', result.playbackByPet)
  }
  return { ok: true, playback: null }
}

function setVoiceSettings(patch = {}) {
  const nextSettings = normalizeVoiceSettings({
    ...getVoiceSettings(),
    ...(patch || {}),
  })
  getStore().set('voiceSettings', nextSettings)
  return nextSettings
}

function migrateVoiceSettings() {
  if (getStore().get(VOICE_SETTINGS_OUTPUT_MIGRATION_KEY)) {
    return getVoiceSettings()
  }

  const nextSettings = setVoiceSettings({
    desktop_voice_output_mode: 'voice_and_text',
  })
  getStore().set(VOICE_SETTINGS_OUTPUT_MIGRATION_KEY, new Date().toISOString())
  logDesktop('voice-settings-migrated', {
    desktop_voice_output_mode: nextSettings.desktop_voice_output_mode,
  })
  return nextSettings
}

function setStoredPetState(payload = {}) {
  const currentState = getPetState()
  const nextState = {
    ...currentState,
    ...payload,
    language: normalizeLanguage(payload.language || currentState.language),
    preferences: {
      ...currentState.preferences,
      ...(payload.preferences || {}),
    },
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'petType')) {
    nextState.petType = normalizePetType(payload.petType)
  } else {
    nextState.petType = normalizePetType(nextState.preferences.pet_type || nextState.petType)
  }

  nextState.preferences.pet_type = nextState.petType
  nextState.hasSession = Boolean(nextState.hasSession)
  if (Object.prototype.hasOwnProperty.call(payload, 'userId')) {
    nextState.userId = Number.isInteger(payload.userId) && payload.userId > 0
      ? payload.userId
      : null
  } else {
    nextState.userId = currentState.userId
  }
  getStore().set('petState', nextState)
  return nextState
}

function sendPetStateToWindow(windowInstance, _state) {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return
  }

  const emit = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }
    const state = getPetState()
    const currentContext = getCurrentStableAccountContext()
    const authoritative = currentContext.hasSession
      ? issueTrustedOperationCapabilityForWindow(windowInstance, 'pet', currentContext)
      : null
    windowInstance.webContents.send('desktop:pet-state-changed', {
      ...state,
      authoritative,
      semantic: currentContext.hasSession
        ? { userId: currentContext.userId, petType: currentContext.petType }
        : null,
    })
  }

  if (windowInstance.webContents.isLoading()) {
    windowInstance.webContents.once('did-finish-load', emit)
    return
  }

  emit()
}

function sendVoiceSettingsToWindow(windowInstance, settings) {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return
  }

  const emit = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }
    windowInstance.webContents.send('desktop:voice-settings-changed', settings)
  }

  if (windowInstance.webContents.isLoading()) {
    windowInstance.webContents.once('did-finish-load', emit)
    return
  }

  emit()
}

function sendCompanionSettingsToWindow(windowInstance, settings) {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return
  }

  const emit = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }
    windowInstance.webContents.send('desktop:companion-settings-changed', settings)
  }

  if (windowInstance.webContents.isLoading()) {
    windowInstance.webContents.once('did-finish-load', emit)
    return
  }

  emit()
}

function sendCompanionStateToWindow(windowInstance, payload) {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return
  }

  const emit = () => {
    if (!windowInstance || windowInstance.isDestroyed()) {
      return
    }
    windowInstance.webContents.send('desktop:companion-state-changed', payload)
  }

  if (windowInstance.webContents.isLoading()) {
    windowInstance.webContents.once('did-finish-load', emit)
    return
  }

  emit()
}

function sendVoiceGlobalShortcutToPet(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return false
  }

  const emit = () => {
    if (!petWindow || petWindow.isDestroyed()) {
      return
    }
    petWindow.webContents.send('desktop:voice-global-shortcut', payload)
  }

  if (petWindow.webContents.isLoading()) {
    petWindow.webContents.once('did-finish-load', emit)
    return true
  }

  emit()
  return true
}

function sendReminderEventToPet(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return false
  }

  const emit = () => {
    if (!petWindow || petWindow.isDestroyed()) {
      return
    }
    petWindow.webContents.send('desktop:pet-reminder-event', payload)
  }

  if (petWindow.webContents.isLoading()) {
    petWindow.webContents.once('did-finish-load', emit)
    return true
  }

  emit()
  return true
}

function sendReminderEventToPetForRenderer(event, payload = {}, expectedContext = null) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['main-panel', 'quick-chat'],
    { requiredScope: 'pet' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (!authorization.ok || payload?.petType !== currentContext.petType) {
    return false
  }
  return sendReminderEventToPet({
    ...payload,
    userId: currentContext.userId,
  })
}

function broadcastVoiceSettings(patch = {}) {
  const nextSettings = setVoiceSettings(patch)
  sendVoiceSettingsToWindow(petWindow, nextSettings)
  sendVoiceSettingsToWindow(quickChatWindow, nextSettings)
  sendVoiceSettingsToWindow(mainPanelWindow, nextSettings)
  registerVoiceGlobalShortcut()
  return nextSettings
}

function broadcastCompanionSettings(patch = {}) {
  const nextSettings = normalizeCompanionSettings({
    ...getCompanionSettings(),
    ...(patch || {}),
  })
  getStore().set('petCompanionSettings', nextSettings)
  sendCompanionSettingsToWindow(petWindow, nextSettings)
  sendCompanionSettingsToWindow(quickChatWindow, nextSettings)
  sendCompanionSettingsToWindow(mainPanelWindow, nextSettings)
  return nextSettings
}

function setPetCompanionState(petType, state = {}, accountUserId = null) {
  const normalizedPetType = normalizePetType(petType)
  const normalizedAccountUserId = normalizeUserId(accountUserId)
  const storageKey = normalizedAccountUserId === null
    ? normalizedPetType
    : `${normalizedAccountUserId}:${normalizedPetType}`
  const stateByPet = getStore().get('petCompanionState') || {}
  const nextState = state && typeof state === 'object' ? { ...state } : {}
  getStore().set('petCompanionState', {
    ...stateByPet,
    [storageKey]: nextState,
  })

  const payload = {
    pet_type: normalizedPetType,
    user_id: normalizedAccountUserId,
    state: nextState,
  }
  sendCompanionStateToWindow(petWindow, payload)
  sendCompanionStateToWindow(quickChatWindow, payload)
  sendCompanionStateToWindow(mainPanelWindow, payload)
  return nextState
}

function getPetCompanionStateForRenderer(event, petType, expectedContext) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet', 'main-panel'],
    { requiredScope: 'pet' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (!authorization.ok || petType !== currentContext.petType) {
    return null
  }
  return getPetCompanionState(petType, currentContext.userId)
}

function setPetCompanionStateForRenderer(event, petType, state, expectedContext) {
  const authorization = authorizeRendererAccountMutation(
    event,
    expectedContext,
    ['pet'],
    { requiredScope: 'pet' },
  )
  const currentContext = getCurrentStableAccountContext()
  if (!authorization.ok || petType !== currentContext.petType) {
    return {
      ok: false,
      reason: authorization.ok ? 'pet-mismatch' : authorization.reason,
    }
  }
  return {
    ok: true,
    state: setPetCompanionState(petType, state, currentContext.userId),
  }
}

function broadcastPetState(payload = {}) {
  const previousState = getPetState()
  const nextState = setStoredPetState(payload)
  if (
    previousState.hasSession !== nextState.hasSession
    || previousState.userId !== nextState.userId
    || previousState.petType !== nextState.petType
  ) {
    resetPetOnboardingEngagementSamples()
  }
  observeAuthoritativeOperationContext()
  sendPetStateToWindow(petWindow, nextState)
  sendPetStateToWindow(quickChatWindow, nextState)
  sendPetStateToWindow(mainPanelWindow, nextState)
  broadcastPetOnboardingState()
  return nextState
}

function setPetPosition(x, y) {
  if (!petWindow || petWindow.isDestroyed()) {
    return null
  }

  const currentBounds = petWindow.getBounds()
  const nextPosition = clampWindowPosition(x, y, currentBounds.width, currentBounds.height)
  petWindow.setPosition(nextPosition.x, nextPosition.y)
  getStore().set('petBounds', {
    ...getStore().get('petBounds'),
    width: currentBounds.width,
    height: currentBounds.height,
    x: nextPosition.x,
    y: nextPosition.y,
  })
  syncQuickChatPosition()
  return nextPosition
}

function getQuickChatAnchorPosition(width, height) {
  if (!petWindow || petWindow.isDestroyed()) {
    return clampWindowPosition(120, 120, width, height)
  }

  const petBounds = petWindow.getBounds()
  const petCenter = {
    x: petBounds.x + Math.round(petBounds.width / 2),
    y: petBounds.y + Math.round(petBounds.height / 2),
  }
  const display = screen.getDisplayNearestPoint(petCenter)
  const workArea = display.workArea
  const rightX = petBounds.x + PET_VISIBLE_WIDTH + 18
  const leftX = petBounds.x - width - 18
  const nextX = rightX + width <= workArea.x + workArea.width || leftX < workArea.x ? rightX : leftX
  const nextY = petBounds.y + Math.round((petBounds.height - height) / 2)

  return clampWindowPosition(nextX, nextY, width, height, display)
}

function getQuickChatPosition(width, height) {
  const quickBounds = getStore().get('quickBounds') || {}
  if (Number.isFinite(quickBounds.x) && Number.isFinite(quickBounds.y)) {
    return clampWindowPosition(quickBounds.x, quickBounds.y, width, height)
  }

  return getQuickChatAnchorPosition(width, height)
}

function syncQuickChatPosition() {
  if (!quickChatWindow || quickChatWindow.isDestroyed() || !quickChatWindow.isVisible()) {
    return null
  }

  const quickBounds = quickChatWindow.getBounds()
  const nextPosition = getQuickChatAnchorPosition(quickBounds.width, quickBounds.height)
  quickChatWindow.setPosition(nextPosition.x, nextPosition.y)
  getStore().set('quickBounds', { ...getStore().get('quickBounds'), x: nextPosition.x, y: nextPosition.y })
  return nextPosition
}

function showPetWindow({ focus = false } = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow()
  }
  if (!petWindow || petWindow.isDestroyed()) {
    return null
  }

  const bounds = getPetBounds()
  const nextPosition = clampWindowPosition(bounds.x, bounds.y, bounds.width, bounds.height)
  petWindow.setBounds({ ...bounds, ...nextPosition })
  getStore().set('petBounds', { ...bounds, ...nextPosition })

  if (!petWindow.isVisible()) {
    petWindow.show()
  }
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.moveTop()
  petWindow.setIgnoreMouseEvents(false)

  if (focus) {
    petWindow.focus()
  }

  sendPetStateToWindow(petWindow, getPetState())
  syncQuickChatPosition()
  return petWindow.getBounds()
}

function unregisterVoiceGlobalShortcut() {
  if (!registeredVoiceGlobalShortcut) {
    return
  }

  globalShortcut.unregister(registeredVoiceGlobalShortcut)
  registeredVoiceGlobalShortcut = null
}

function activatePetVoiceFromGlobalShortcut() {
  const voiceSettings = getVoiceSettings()
  if (!voiceSettings.desktop_voice_enabled) {
    logDesktop('voice-global-shortcut-ignored', {
      reason: 'disabled',
      accelerator: voiceSettings.desktop_voice_global_shortcut,
    })
    return false
  }

  showPetWindow({ focus: true })
  const delivered = sendVoiceGlobalShortcutToPet({
    accelerator: voiceSettings.desktop_voice_global_shortcut,
    triggeredAt: new Date().toISOString(),
  })
  logDesktop('voice-global-shortcut-triggered', {
    accelerator: voiceSettings.desktop_voice_global_shortcut,
    delivered,
  })
  return delivered
}

function registerVoiceGlobalShortcut() {
  if (!app.isReady()) {
    return false
  }

  unregisterVoiceGlobalShortcut()
  const voiceSettings = getVoiceSettings()
  if (!voiceSettings.desktop_voice_enabled) {
    return false
  }

  const accelerator = voiceSettings.desktop_voice_global_shortcut
  try {
    const registered = globalShortcut.register(accelerator, activatePetVoiceFromGlobalShortcut)
    if (!registered) {
      logDesktop('voice-global-shortcut-register-failed', { accelerator })
      return false
    }

    registeredVoiceGlobalShortcut = accelerator
    logDesktop('voice-global-shortcut-registered', { accelerator })
    return true
  } catch (error) {
    logDesktop('voice-global-shortcut-register-failed', {
      accelerator,
      message: error?.message || 'unknown',
    })
    return false
  }
}

function resetPetPosition() {
  const nextPosition = { width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT, x: 90, y: 90 }
  getStore().set('petBounds', nextPosition)

  if (!petWindow || petWindow.isDestroyed()) {
    return nextPosition
  }

  petWindow.setBounds(nextPosition)
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.moveTop()
  petWindow.show()
  petWindow.setIgnoreMouseEvents(false)
  syncQuickChatPosition()
  return nextPosition
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    return
  }

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
      sandbox: false,
      additionalArguments: isE2e ? ['--detachym-e2e=1'] : [],
    },
  })

  petWindow.__role = 'pet'
  attachRendererNavigationGuard(petWindow, 'pet.html')
  attachRendererCapabilityLifecycle(petWindow)
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  persistBounds('petBounds', petWindow, { saveSize: false })
  petWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      petWindow.hide()
    }
  })
  petWindow.on('move', () => {
    syncQuickChatPosition()
  })
  petWindow.webContents.on('did-finish-load', () => {
    sendPetStateToWindow(petWindow, getPetState())
    sendVoiceSettingsToWindow(petWindow, getVoiceSettings())
    sendPetOnboardingStateToWindow(petWindow)
  })

  loadWindow(petWindow, 'pet.html')
}

function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    return
  }

  const quickBounds = getStore().get('quickBounds') || {}
  quickChatWindow = new BrowserWindow({
    width: QUICK_CHAT_WIDTH,
    height: QUICK_CHAT_HEIGHT,
    ...getQuickChatPosition(
      QUICK_CHAT_WIDTH,
      QUICK_CHAT_HEIGHT,
    ),
    title: 'Detachym 快捷聊天',
    icon: getWindowIconPath(),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: isE2e ? ['--detachym-e2e=1'] : [],
    },
  })

  quickChatWindow.__role = 'quick-chat'
  attachRendererNavigationGuard(quickChatWindow, 'quick-chat.html')
  attachRendererCapabilityLifecycle(quickChatWindow)
  quickChatWindow.setTitle(getWindowTitle('quickChat'))
  quickChatWindow.removeMenu()
  quickChatWindow.setMenuBarVisibility(false)
  persistBounds('quickBounds', quickChatWindow)
  quickChatWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      quickChatWindow.hide()
    }
  })
  quickChatWindow.webContents.on('did-finish-load', () => {
    sendPetStateToWindow(quickChatWindow, getPetState())
    sendVoiceSettingsToWindow(quickChatWindow, getVoiceSettings())
  })

  loadWindow(quickChatWindow, 'quick-chat.html')
}

function createMainPanelWindow() {
  if (mainPanelWindow && !mainPanelWindow.isDestroyed()) {
    return
  }

  const mainBounds = getStore().get('mainBounds') || {}
  mainPanelWindow = new BrowserWindow({
    width: Math.max(MAIN_PANEL_WIDTH, Number(mainBounds.width) || MAIN_PANEL_WIDTH),
    height: Math.max(MAIN_PANEL_HEIGHT, Number(mainBounds.height) || MAIN_PANEL_HEIGHT),
    x: Number.isFinite(mainBounds.x) ? mainBounds.x : undefined,
    y: Number.isFinite(mainBounds.y) ? mainBounds.y : undefined,
    title: 'Detachym 桌宠客户端',
    icon: getWindowIconPath(),
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: isE2e ? ['--detachym-e2e=1'] : [],
    },
  })

  mainPanelWindow.__role = 'main-panel'
  attachRendererNavigationGuard(mainPanelWindow, 'main-panel.html')
  attachRendererCapabilityLifecycle(mainPanelWindow)
  getMainPanelIntentCoordinator().markRendererNotReady()
  mainPanelWindow.setTitle(getWindowTitle('mainPanel'))
  mainPanelWindow.removeMenu()
  mainPanelWindow.setMenuBarVisibility(false)
  persistBounds('mainBounds', mainPanelWindow)
  mainPanelWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainPanelWindow.hide()
    }
  })
  mainPanelWindow.webContents.on('did-start-loading', () => {
    getMainPanelIntentCoordinator().markRendererNotReady()
  })
  mainPanelWindow.webContents.on('did-finish-load', () => {
    sendPetStateToWindow(mainPanelWindow, getPetState())
    sendVoiceSettingsToWindow(mainPanelWindow, getVoiceSettings())
    sendPetOnboardingStateToWindow(mainPanelWindow)
  })
  mainPanelWindow.webContents.on(
    'did-fail-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame !== false) {
        getMainPanelIntentCoordinator().failPending('main-frame-load-failed')
      }
    },
  )
  mainPanelWindow.webContents.on('render-process-gone', () => {
    getMainPanelIntentCoordinator().failPending('renderer-process-gone')
  })
  mainPanelWindow.on('closed', () => {
    getMainPanelIntentCoordinator().failPending('window-destroyed')
    // attachRendererCapabilityLifecycle already revokes the captured sender on
    // destruction. Accessing webContents here throws after BrowserWindow dies.
    mainPanelWindow = null
  })

  void loadWindow(mainPanelWindow, 'main-panel.html').catch((error) => {
    getMainPanelIntentCoordinator().failPending('main-frame-load-failed')
    logDesktop('main-panel-load-failed', { message: error?.message || 'unknown' })
  })
}

function openQuickChat() {
  createQuickChatWindow()
  if (!quickChatWindow || !petWindow) {
    return false
  }

  const quickBounds = quickChatWindow.getBounds()
  const nextPosition = getQuickChatPosition(quickBounds.width, quickBounds.height)
  quickChatWindow.setSize(quickBounds.width, quickBounds.height)
  quickChatWindow.setPosition(nextPosition.x, nextPosition.y)
  getStore().set('quickBounds', { ...getStore().get('quickBounds'), x: nextPosition.x, y: nextPosition.y })
  sendPetStateToWindow(quickChatWindow, getPetState())
  sendVoiceSettingsToWindow(quickChatWindow, getVoiceSettings())
  quickChatWindow.show()
  quickChatWindow.focus()
  return true
}

function hideQuickChat() {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) {
    return false
  }
  quickChatWindow.hide()
  return false
}

function toggleQuickChat() {
  createQuickChatWindow()
  if (!quickChatWindow || !petWindow) {
    return false
  }

  if (quickChatWindow.isVisible()) {
    return hideQuickChat()
  }

  return openQuickChat()
}

function openMainPanel(options = {}) {
  createMainPanelWindow()
  if (!mainPanelWindow || mainPanelWindow.isDestroyed()) {
    return false
  }

  mainPanelWindow.show()
  mainPanelWindow.focus()
  if (options?.intent === 'pet-onboarding-relationship') {
    return getMainPanelIntentCoordinator().request(options.intent, {
      context: options.expectedContext,
      semantic: options.semantic,
    })
  }
  return true
}

async function openMainPanelForRenderer(event, options = {}) {
  if (options?.intent === 'pet-onboarding-relationship') {
    const authorizeSource = () => operationCapabilities.authorize({
      sender: event?.sender,
      senderRole: getIpcSenderRole(event),
      capability: options.expectedContext,
      requiredScope: 'relationship',
      currentContext: getCurrentStableAccountContext(),
    })
    const authorization = authorizeSource()
    if (getIpcSenderRole(event) !== 'pet' || !authorization.ok) {
      return false
    }
    createMainPanelWindow()
    if (!mainPanelWindow || mainPanelWindow.isDestroyed()) return false
    const consumerWindow = mainPanelWindow
    if (!await waitForRendererInstance(consumerWindow)) return false
    if (
      consumerWindow !== mainPanelWindow
      || consumerWindow.isDestroyed()
      || getIpcSenderRole(event) !== 'pet'
      || !authorizeSource().ok
    ) return false
    const currentContext = getCurrentStableAccountContext()
    const consumerCapability = issueTrustedOperationCapabilityForWindow(
      consumerWindow,
      'relationship',
      currentContext,
    )
    if (!consumerCapability) return false
    const intentSequence = e2eRuntime.intentSequence + 1
    e2eRuntime.intentSequence = intentSequence
    e2eRuntime.intent = {
      contextUserId: currentContext.userId,
      lastResult: e2eRuntime.intent.lastResult,
    }
    const opened = await openMainPanel({
      ...options,
      expectedContext: consumerCapability,
      semantic: {
        userId: currentContext.userId,
        petType: currentContext.petType,
        relationshipId: currentContext.relationshipId,
      },
    })
    if (e2eRuntime.intentSequence === intentSequence) {
      e2eRuntime.intent = {
        contextUserId: currentContext.userId,
        lastResult: opened === true,
      }
    }
    if (isE2e && opened === true) {
      e2eRuntime.activityJournal.push({
        kind: 'intent',
        userId: currentContext.userId,
        afterAccountSwitch: getCurrentStableAccountContext().userId !== currentContext.userId,
      })
    }
    return opened
  }
  return openMainPanel(options)
}

function hideMainPanel() {
  if (!mainPanelWindow || mainPanelWindow.isDestroyed()) {
    return false
  }
  mainPanelWindow.hide()
  return true
}

function minimizeMainPanel() {
  if (!mainPanelWindow || mainPanelWindow.isDestroyed()) {
    return false
  }
  mainPanelWindow.minimize()
  return true
}

function buildTrayMenu() {
  const messages = getLanguageMessages()

  return Menu.buildFromTemplate([
    { label: messages.showPet, click: () => showPetWindow() },
    { label: messages.resetPetPosition, click: () => resetPetPosition() },
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
  if (tray) {
    return
  }
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

function switchPetFromMainPanel(payload = {}) {
  const nextPetType = normalizePetType(payload.petType)
  const nextState = broadcastPetState({
    source: 'main-panel',
    hasSession: true,
    language: payload.language || getStore().get('language'),
    preferences: payload.preferences || {},
    petType: nextPetType,
  })
  logDesktop('switch-pet-live', {
    petType: nextPetType,
  })
  return { ok: true, state: nextState }
}

function switchPetFromMainPanelForRenderer(event, payload = {}) {
  const sessionSubject = getCurrentSessionSubject()
  const activeState = getPetState()
  const authorization = authorizeSwitchPet({
    senderRole: getIpcSenderRole(event),
    expectedUserId: payload.expectedUserId ?? payload.userId,
    currentSessionSubject: sessionSubject,
    activeUserId: activeState.userId,
    expectedSession: payload.expectedSession,
    currentSession: getCurrentSessionSnapshot(),
    expectedFromPet: payload.expectedFromPet,
    currentPet: activeState.petType,
  })
  if (!authorization.ok) {
    return authorization
  }
  const capabilityAuthorization = operationCapabilities.authorize({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    capability: payload.expectedContext,
    requiredScope: 'pet',
    currentContext: getCurrentStableAccountContext(),
  })
  if (!capabilityAuthorization.ok) return capabilityAuthorization
  const transition = operationCapabilities.transition({
    sender: event?.sender,
    senderRole: getIpcSenderRole(event),
    capability: payload.expectedContext,
    requiredScope: 'pet',
    currentContext: getCurrentStableAccountContext(),
    nextScope: 'pet',
    apply: () => switchPetFromMainPanel(payload),
    getCurrentContext: getCurrentStableAccountContext,
  })
  if (!transition.ok) return transition
  return { ...transition.value, authoritative: transition.capability }
}

function syncPetState(payload = {}) {
  return broadcastPetState(payload)
}

function syncPetStateForRenderer(event, payload = {}) {
  if (getIpcSenderRole(event) !== 'main-panel') {
    return { ok: false, reason: 'forbidden' }
  }
  const incomingHasSession = payload?.hasSession === true
  const incomingUserId = normalizeUserId(payload?.userId)
  const sessionSubject = getCurrentSessionSubject()
  if (
    (incomingHasSession && (sessionSubject === null || incomingUserId !== sessionSubject))
    || (!incomingHasSession && (sessionSubject !== null || incomingUserId !== null))
  ) {
    return { ok: false, reason: 'identity-mismatch' }
  }
  if (
    incomingHasSession
    && !isExactSessionSnapshot(payload?.expectedSession, getCurrentSessionSnapshot())
  ) {
    return { ok: false, reason: 'session-mismatch' }
  }
  if (incomingHasSession) {
    const transition = operationCapabilities.transition({
      sender: event?.sender,
      senderRole: getIpcSenderRole(event),
      capability: payload.expectedContext,
      requiredScope: 'account',
      currentContext: getCurrentStableAccountContext(),
      nextScope: 'pet',
      apply: () => syncPetState(payload),
      getCurrentContext: getCurrentStableAccountContext,
    })
    if (!transition.ok) return transition
    return { ok: true, state: transition.value, authoritative: transition.capability }
  }
  return syncPetState(payload)
}

function setSessionTokenForRenderer(event, token) {
  if (getIpcSenderRole(event) !== 'main-panel') {
    return false
  }
  const sessionSubject = getUnverifiedJwtSubject(token)
  if (sessionSubject === null) {
    return false
  }
  if (token === getStore().get('sessionToken')) {
    return true
  }
  operationCapabilities.resetCapabilities()
  broadcastPetState({ hasSession: false, userId: null })
  clearAccountScopedPetContext()
  getStore().set('sessionToken', token)
  sessionGeneration += 1
  broadcastPetState({ hasSession: true, userId: sessionSubject })
  return true
}

function getCurrentSessionSnapshot() {
  const token = getStore().get('sessionToken')
  return { token: typeof token === 'string' && token ? token : null, generation: sessionGeneration }
}

function clearSessionTokenForRenderer(event, expectedSession) {
  const currentToken = getStore().get('sessionToken')
  if (!authorizeSessionClear({
    senderRole: getIpcSenderRole(event),
    expectedSession,
    currentSession: getCurrentSessionSnapshot(),
  })) {
    return false
  }
  const changed = Boolean(currentToken)
  getStore().set('sessionToken', null)
  if (changed) {
    sessionGeneration += 1
    operationCapabilities.resetCapabilities()
  }
  clearAccountScopedPetContext()
  syncPetState({
    hasSession: false,
    userId: null,
    petType: 'cat',
    preferences: {
      pet_type: 'cat',
      quick_chat_enabled: true,
      bubble_frequency: 120,
    },
  })
  return true
}

function getRuntimeState() {
  return {
    petState: getPetState(),
    petRelationshipCache: getStore().get('petRelationshipCache') || {},
    petMilestonePlayback: getStore().get('petMilestonePlayback') || {},
    voiceSettings: getVoiceSettings(),
    companionSettings: getCompanionSettings(),
    companionState: getStore().get('petCompanionState') || {},
    voiceGlobalShortcut: {
      registered: registeredVoiceGlobalShortcut,
    },
    windows: {
      petVisible: Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
      quickChatVisible: Boolean(quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()),
      mainPanelVisible: Boolean(mainPanelWindow && !mainPanelWindow.isDestroyed() && mainPanelWindow.isVisible()),
    },
    rendererHeartbeats: rendererHeartbeatState,
  }
}

function getRuntimeStateForRenderer(event) {
  return createRuntimeStateForRole({
    role: getIpcSenderRole(event),
    runtimeState: getRuntimeState(),
  })
}

function getWindowForRole(role) {
  if (role === 'pet') return petWindow
  if (role === 'quick-chat') return quickChatWindow
  if (role === 'main-panel') return mainPanelWindow
  return null
}

function sendE2eLocalReset() {
  for (const windowInstance of [petWindow, quickChatWindow, mainPanelWindow]) {
    if (windowInstance && !windowInstance.isDestroyed()) {
      windowInstance.webContents.send('desktop:e2e-reset-local')
    }
  }
}

function getE2eOnboardingSnapshot() {
  const state = loadPetOnboardingState({ createIfEligible: false }).state
  if (!state) return null
  const observed = state.observed_capability_ids || []
  return {
    ...state,
    status: state.status === 'finished' && state.finish_reason === 'completed'
      ? 'completed'
      : state.status,
    observedRelationship: observed.includes(PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED),
  }
}

function getE2eSnapshot() {
  const context = getCurrentStableAccountContext()
  const relationship = context.hasSession ? getCachedPetRelationship(context.petType) : null
  return {
    account: context.hasSession
      ? { userId: context.userId, petType: context.petType }
      : null,
    relationship: relationship ? { ...relationship } : null,
    onboarding: getE2eOnboardingSnapshot(),
    intent: {
      pending: getMainPanelIntentCoordinator().hasPending(),
      contextUserId: e2eRuntime.intent.contextUserId,
      lastResult: e2eRuntime.intent.lastResult,
    },
    lastCompletedRequest: e2eRuntime.lastCompletedRequest
      ? { ...e2eRuntime.lastCompletedRequest }
      : null,
    activityJournal: e2eRuntime.activityJournal.map((entry) => ({ ...entry })),
  }
}

function applyE2eAccountFixture(fixture = {}, { reset = false } = {}) {
  if (!isE2e) return false
  const account = fixture?.account
  const hasAccount = Boolean(account)
  const userId = hasAccount ? normalizeUserId(account.userId) : null
  const petType = hasAccount ? normalizePetType(account.petType) : 'cat'
  const token = hasAccount && typeof account.token === 'string' ? account.token : null
  const relationship = hasAccount && fixture?.relationship && typeof fixture.relationship === 'object'
    ? { ...fixture.relationship, pet_type: petType }
    : null
  if (
    hasAccount
    && (
      userId === null
      || getUnverifiedJwtSubject(token) !== userId
      || normalizeUserId(relationship?.user_id ?? relationship?.userId) !== userId
      || normalizeUserId(relationship?.id) === null
    )
  ) return false

  if (reset) {
    getMainPanelIntentCoordinator().failPending('e2e-reset')
    e2eRuntime.intentSequence += 1
    e2eRuntime.intent = { contextUserId: null, lastResult: null }
    e2eRuntime.lastCompletedRequest = null
    e2eRuntime.activityJournal = []
    getStore().set('petOnboardingStates', {})
    getStore().set('apiBaseUrl', defaultApiBaseUrl)
  }

  operationCapabilities.resetCapabilities()
  sessionGeneration += 1
  resetPetOnboardingEngagementSamples()
  getStore().set('sessionToken', token)
  getStore().set('petRelationshipCache', relationship ? { [petType]: relationship } : {})
  getStore().set('petMilestonePlayback', {})
  getStore().set('petCompanionState', {})
  const nextState = {
    petType,
    hasSession: hasAccount,
    userId,
    language: DEFAULT_LANGUAGE,
    preferences: {
      pet_type: petType,
      quick_chat_enabled: true,
      bubble_frequency: 120,
    },
  }
  getStore().set('petState', nextState)
  broadcastPetState(nextState)
  for (const windowInstance of [petWindow, quickChatWindow, mainPanelWindow]) {
    sendPetRelationshipToWindow(windowInstance, relationship)
  }
  broadcastPetOnboardingState()
  sendE2eLocalReset()
  return getE2eSnapshot()
}

function prepareE2ePetOnboarding(options = {}) {
  if (!isE2e || !['meet_pet', 'relationship'].includes(options?.scene)) return false
  const context = getPetOnboardingContext()
  const key = context ? createPetOnboardingKey(context.user_id, context.relationship_id) : null
  const base = context ? createPetOnboardingState(context, new Date()) : null
  if (!key || !base) return false
  const visibleEngagementMs = Number.isFinite(Number(options.visibleEngagementMs))
    ? Math.max(0, Math.min(179_999, Math.floor(Number(options.visibleEngagementMs))))
    : 0
  const relationshipScene = options.scene === 'relationship'
  const state = {
    ...base,
    engaged_elapsed_ms: visibleEngagementMs,
    shown_step_ids: relationshipScene ? ['meet_pet'] : [],
    observed_capability_ids: relationshipScene
      ? [PET_ONBOARDING_CAPABILITIES.PET_INTERACTION]
      : [],
    revision: (loadPetOnboardingState({ createIfEligible: false }).state?.revision || 0) + 1,
  }
  getStore().set('petOnboardingStates', {
    ...(getStore().get('petOnboardingStates') || {}),
    [key]: state,
  })
  petOnboardingEngagementSamples.set(key, {
    context_key: key,
    monotonic_ms: performance.now() + 10_000,
  })
  broadcastPetOnboardingState()
  return true
}

function recordE2eRequestCompletion(event, payload = {}) {
  if (!isE2e || !getIpcSenderRole(event)) return false
  const userId = normalizeUserId(payload.userId)
  const pathValue = typeof payload.path === 'string' ? payload.path.split('?')[0] : ''
  if (!userId || !pathValue.startsWith('/') || pathValue.length > 256) return false
  const entry = {
    kind: 'request',
    userId,
    afterAccountSwitch: getCurrentStableAccountContext().userId !== userId,
    path: pathValue,
    ok: payload.ok === true,
  }
  e2eRuntime.lastCompletedRequest = { path: entry.path, ok: entry.ok }
  e2eRuntime.activityJournal.push(entry)
  if (e2eRuntime.activityJournal.length > 128) e2eRuntime.activityJournal.shift()
  return true
}

function showE2eWindow(role) {
  if (role === 'pet') return Boolean(showPetWindow({ focus: true }))
  if (role === 'quick-chat') return openQuickChat()
  if (role === 'main-panel') return openMainPanel()
  return false
}

function destroyE2eWindow(role) {
  const windowInstance = getWindowForRole(role)
  if (!windowInstance || windowInstance.isDestroyed()) return false
  windowInstance.destroy()
  return true
}

function recreateE2eWindow(role) {
  if (role === 'pet') createPetWindow()
  else if (role === 'quick-chat') createQuickChatWindow()
  else if (role === 'main-panel') createMainPanelWindow()
  else return false
  const windowInstance = getWindowForRole(role)
  return Boolean(windowInstance && !windowInstance.isDestroyed())
}

function broadcastE2eRelationship(role, relationship) {
  if (!isE2e || !relationship || typeof relationship !== 'object') return false
  const windowInstance = getWindowForRole(role)
  const current = getCurrentStableAccountContext()
  if (
    !windowInstance
    || windowInstance.isDestroyed()
    || normalizeUserId(relationship.user_id ?? relationship.userId) !== current.userId
    || normalizePetType(relationship.pet_type ?? relationship.petType) !== current.petType
    || normalizeUserId(relationship.id) !== current.relationshipId
  ) return false
  sendPetRelationshipToWindow(windowInstance, relationship)
  return true
}

async function handleE2eControl(event, method, ...args) {
  if (!isE2e || !getIpcSenderRole(event)) return null
  if (method === 'describe') {
    return { protocolVersion: E2E_PROTOCOL_VERSION, role: getIpcSenderRole(event) }
  }
  if (method === 'reset') {
    const fixture = args[0]
    if (fixture?.protocolVersion !== E2E_PROTOCOL_VERSION) return false
    return applyE2eAccountFixture(fixture, { reset: true })
  }
  if (method === 'snapshot') return getE2eSnapshot()
  if (method === 'showWindow') return showE2eWindow(args[0])
  if (method === 'prepareOnboarding') return prepareE2ePetOnboarding(args[0])
  if (method === 'expireOperationCapabilities') {
    return { expired: operationCapabilities.expireAll() }
  }
  if (method === 'switchAccount') {
    return applyE2eAccountFixture({ account: args[0], relationship: args[0]?.relationship })
  }
  if (method === 'destroyWindow') return destroyE2eWindow(args[0])
  if (method === 'recreateWindow') return recreateE2eWindow(args[0])
  if (method === 'broadcastRelationshipTo') return broadcastE2eRelationship(args[0], args[1])
  if (method === 'rejectMainPanelIntent') {
    return getMainPanelIntentCoordinator().failPending('e2e-renderer-rejected')
  }
  if (method === 'recordRequestCompletion') return recordE2eRequestCompletion(event, args[0])
  return null
}

function registerIpc() {
  if (isE2e) {
    ipcMain.handle('desktop:e2e-control', handleE2eControl)
  }
  ipcMain.handle('desktop:open-main-panel', async (event, options) => (
    openMainPanelForRenderer(event, options)
  ))
  ipcMain.handle('desktop:main-panel-intent-ready', async (event) => {
    if (getIpcSenderRole(event) !== 'main-panel') {
      return false
    }
    return getMainPanelIntentCoordinator().markRendererReady()
  })
  ipcMain.handle('desktop:main-panel-intent-not-ready', async (event) => {
    if (getIpcSenderRole(event) !== 'main-panel') {
      return false
    }
    getMainPanelIntentCoordinator().markRendererNotReady()
    return true
  })
  ipcMain.handle('desktop:main-panel-intent-ack', async (event, id) => {
    if (getIpcSenderRole(event) !== 'main-panel') {
      return false
    }
    return getMainPanelIntentCoordinator().acknowledge(id)
  })
  ipcMain.handle('desktop:minimize-main-panel', async () => minimizeMainPanel())
  ipcMain.handle('desktop:hide-main-panel', async () => hideMainPanel())
  ipcMain.handle('desktop:open-quick-chat', async () => openQuickChat())
  ipcMain.handle('desktop:hide-quick-chat', async () => hideQuickChat())
  ipcMain.handle('desktop:toggle-quick-chat', async () => toggleQuickChat())
  ipcMain.handle('desktop:show-pet', async () => showPetWindow())
  ipcMain.handle('desktop:focus-pet-window', async () => {
    showPetWindow({ focus: true })
    return true
  })
  ipcMain.handle('desktop:reset-pet-position', async () => resetPetPosition())
  ipcMain.handle('desktop:set-pet-interactive', async (_event, interactive) => {
    if (!petWindow || petWindow.isDestroyed()) {
      return false
    }
    petWindow.setIgnoreMouseEvents(!interactive)
    return Boolean(interactive)
  })
  ipcMain.handle('desktop:switch-pet-from-main-panel', async (event, payload) => (
    switchPetFromMainPanelForRenderer(event, payload)
  ))
  ipcMain.handle('desktop:sync-pet-state', async (event, payload) => (
    syncPetStateForRenderer(event, payload)
  ))
  ipcMain.handle(
    'desktop:notify-pet-reminder-event',
    async (event, payload, expectedContext) => (
      sendReminderEventToPetForRenderer(event, payload, expectedContext)
    ),
  )
  ipcMain.handle('desktop:get-pet-state', async (event) => (
    getIpcSenderRole(event) ? getPetState() : null
  ))
  ipcMain.handle('desktop:register-renderer-instance', async (event, rendererInstanceNonce) => (
    registerRendererInstanceForEvent(event, rendererInstanceNonce)
  ))
  ipcMain.handle('desktop:capture-operation-context', async (
    event,
    scope,
    expectedContext,
    rendererInstanceNonce,
  ) => captureAuthoritativeOperationContextForRenderer(
    event,
    scope,
    expectedContext,
    rendererInstanceNonce,
  ))
  ipcMain.handle('desktop:renew-operation-context', async (
    event,
    capability,
    requiredScope,
    semantic,
    rendererInstanceNonce,
  ) => renewAuthoritativeOperationContextForRenderer(
    event,
    capability,
    requiredScope,
    semantic,
    rendererInstanceNonce,
  ))
  ipcMain.handle('desktop:validate-operation-context', async (
    event,
    snapshot,
    requiredScope,
    semantic,
    rendererInstanceNonce,
  ) => (
    validateAuthoritativeOperationContextForRenderer(
      event,
      snapshot,
      requiredScope,
      semantic,
      rendererInstanceNonce,
    )
  ))
  ipcMain.handle('desktop:get-cached-pet-relationship', async (event, petType, expectedContext) => (
    getCachedPetRelationshipForRenderer(event, petType, expectedContext)
  ))
  ipcMain.handle('desktop:cache-pet-relationship', async (event, payload, expectedContext) => (
    cachePetRelationshipForRenderer(event, payload, expectedContext)
  ))
  ipcMain.handle('desktop:get-pet-milestone-playback', async (event, petType, expectedContext) => (
    getPetMilestonePlaybackForRenderer(event, petType, expectedContext)
  ))
  ipcMain.handle('desktop:set-pet-milestone-playback', async (
    event,
    petType,
    playback,
    expectedRevision,
    expectedContext,
  ) => (
    setPetMilestonePlaybackForRenderer(
      event,
      petType,
      playback,
      expectedRevision,
      expectedContext,
    )
  ))
  ipcMain.handle('desktop:clear-pet-milestone-playback', async (
    event,
    petType,
    claimToken,
    expectedRevision,
    expectedContext,
  ) => (
    clearPetMilestonePlaybackForRenderer(
      event,
      petType,
      claimToken,
      expectedRevision,
      expectedContext,
    )
  ))
  ipcMain.handle(
    'desktop:get-pet-onboarding-state',
    async (event, petType, expectedContext) => (
      getPetOnboardingStateForRenderer(event, petType, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:record-pet-onboarding-observation',
    async (event, petType, capabilityId, payload, expectedContext) => (
      recordPetOnboardingObservation(event, petType, capabilityId, payload, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:record-pet-onboarding-engagement',
    async (event, petType, deltaMs, expectedContext) => (
      recordPetOnboardingEngagement(event, petType, deltaMs, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:claim-pet-onboarding-presentation',
    async (event, petType, stepId, token, expectedContext) => (
      claimPetOnboardingPresentation(event, petType, stepId, token, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:ack-pet-onboarding-presentation',
    async (event, petType, stepId, token, expectedContext) => (
      ackPetOnboardingPresentation(event, petType, stepId, token, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:release-pet-onboarding-presentation',
    async (event, petType, stepId, token, expectedContext) => (
      releasePetOnboardingPresentation(event, petType, stepId, token, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:snooze-pet-onboarding',
    async (event, petType, expectedContext) => (
      snoozePetOnboarding(event, petType, expectedContext)
    ),
  )
  ipcMain.handle(
    'desktop:dismiss-pet-onboarding',
    async (event, petType, expectedContext) => (
      dismissPetOnboarding(event, petType, expectedContext)
    ),
  )

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
    const nextState = syncPetState({ language: nextLanguage })
    refreshTray()
    return nextState.language
  })
  ipcMain.handle('desktop:get-pet-bounds', async () => {
    if (!petWindow || petWindow.isDestroyed()) {
      return getPetBounds()
    }
    return petWindow.getBounds()
  })
  ipcMain.handle('desktop:get-voice-settings', async () => getVoiceSettings())
  ipcMain.handle('desktop:update-voice-settings', async (_event, patch) => broadcastVoiceSettings(patch))
  ipcMain.handle('desktop:get-companion-settings', async () => getCompanionSettings())
  ipcMain.handle('desktop:update-companion-settings', async (_event, patch) =>
    broadcastCompanionSettings(patch),
  )
  ipcMain.handle('desktop:get-companion-state', async (event, petType, expectedContext) =>
    getPetCompanionStateForRenderer(event, petType, expectedContext),
  )
  ipcMain.handle('desktop:set-companion-state', async (event, petType, state, expectedContext) =>
    setPetCompanionStateForRenderer(event, petType, state, expectedContext),
  )
  ipcMain.handle('desktop:get-system-idle-seconds', async () => {
    try {
      // CDP input does not reset the Windows idle clock. The isolated E2E
      // fixture models an active user; real idle/sleep is a separate smoke check.
      return isE2e ? 0 : powerMonitor.getSystemIdleTime()
    } catch {
      return 0
    }
  })
  ipcMain.handle('desktop:set-pet-position', async (_event, position) => {
    if (!position || typeof position !== 'object') {
      return null
    }
    return setPetPosition(position.x, position.y)
  })

  ipcMain.handle('desktop:show-notification', async (event, payload, expectedContext) => {
    const senderRole = getIpcSenderRole(event)
    const isLoginNotification = senderRole === 'main-panel' && !expectedContext
    const notificationAuthorization = isLoginNotification
      ? { ok: true }
      : operationCapabilities.authorize({
          sender: event?.sender,
          senderRole,
          capability: expectedContext,
          requiredScope: 'pet',
          currentContext: getCurrentStableAccountContext(),
        })
    if (!notificationAuthorization.ok || (!isLoginNotification && senderRole !== 'pet')) {
      return false
    }
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

  ipcMain.handle('desktop:get-session-token', async (event) => (
    getIpcSenderRole(event) ? getStore().get('sessionToken') : null
  ))
  ipcMain.handle('desktop:get-session-snapshot', async (event) => (
    getIpcSenderRole(event) ? getCurrentSessionSnapshot() : null
  ))
  ipcMain.handle('desktop:set-session-token', async (event, token) => (
    setSessionTokenForRenderer(event, token)
  ))
  ipcMain.handle('desktop:clear-session-token', async (event, expectedToken) => (
    clearSessionTokenForRenderer(event, expectedToken)
  ))

  ipcMain.handle('desktop:log-debug', async (event, payload) => {
    const result = createRendererTelemetryRecord({
      role: getIpcSenderRole(event),
      event: 'renderer-debug',
      payload,
    })
    if (!result.ok) return false
    logDesktop('renderer-debug', result.record)
    return true
  })
  ipcMain.handle('desktop:renderer-heartbeat', async (event, payload) => {
    const result = createRendererHeartbeatRecord({
      role: getIpcSenderRole(event),
      payload,
    })
    if (!result.ok) return false
    rendererHeartbeatState[result.key] = result.heartbeat
    return true
  })
  ipcMain.handle('desktop:get-runtime-state', async (event) => (
    getRuntimeStateForRenderer(event)
  ))
  ipcMain.handle('desktop:get-log-paths', async () => ({
    logPath: ensureDebugLogPath(),
  }))
}

function bootstrap() {
  Menu.setApplicationMenu(null)
  registerIpc()
  createPetWindow()
  createQuickChatWindow()
  createMainPanelWindow()
  createTray()
  registerVoiceGlobalShortcut()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showPetWindow({ focus: true })
    openMainPanel()
  })

  app.whenReady().then(async () => {
    store = await createStore()
    migrateVoiceSettings()
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

  app.on('will-quit', () => {
    unregisterVoiceGlobalShortcut()
  })
}
