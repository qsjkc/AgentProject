import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { MessageCircle, Minus, Plus, Settings2, Sprout, X } from 'lucide-react'

import './desktop.css'
import './main-panel.css'
import { PetOnboardingCard } from './components/PetOnboardingCard'
import { PendingReminderPanel } from './components/PendingReminderPanel'
import { RecurringReminderPanel } from './components/RecurringReminderPanel'
import { PetOutfitPanel } from './components/PetOutfitPanel'
import { PetWeeklySummaryPanel } from './components/PetWeeklySummaryPanel'
import { FocusSessionPanel } from './components/FocusSessionPanel'
import { ChatMessageStream } from './components/ChatMessageStream'
import {
  checkApiConnection,
  beginLoginAttempt,
  cancelLoginAttempt,
  captureApiOperationContext,
  assertApiOperationContextCurrent,
  clearSessionToken,
  desktopApi,
  getApiBaseUrl,
  getCompanionSettings,
  getLanguage,
  getSessionToken,
  getSessionSnapshot,
  getVoiceSettings,
  login,
  openQuickChat,
  setApiBaseUrl,
  setLanguage,
  updateVoiceSettings,
  updateCompanionSettings,
} from './shared/api'
import {
  COMPANION_MODES,
  DEFAULT_COMPANION_SETTINGS,
  DEFAULT_COMPANION_STATE,
  getCompanionStatusKey,
  normalizeCompanionSettings,
  normalizeCompanionState,
} from './shared/pet-companion'
import { normalizeLanguage, SUPPORTED_LANGUAGES, t } from './shared/i18n'
import { restoreFailedChatDraft, shouldSubmitChatInput } from './shared/chat-input'
import { getPetReminderCopy } from './shared/pet-personality'
import {
  createRewardIdempotencyKey,
  getRelationshipStageLabel,
  normalizePetRelationship,
} from './shared/pet-relationship'
import {
  commitAccountOperation,
  createAccountOperationGate,
  createLocalOperationContext,
  adoptRelationshipCapability,
  createMainPanelRelationshipNullReset,
  isPetAccountOperationCurrent,
  isSessionSnapshotCurrent,
  runAccountOperation,
} from './shared/pet-account-context'
import { createMainPanelIntentConsumerController } from './shared/main-panel-intent-controller'
import { createLoginOperations } from './shared/login-operations'
import {
  getPetDailySummaryHighlights,
  getPetDailySummaryMessage,
} from './shared/pet-daily-summary'
import {
  getPetDailySummary,
  getPetRelationship,
  rewardPetRelationship,
  updatePetOutfit,
} from './shared/pet-relationships-api'
import { getPetVisual } from './shared/pets'
import {
  createPetOnboardingContextKey,
  createPetOnboardingSampleReminderPayload,
  derivePetOnboardingScene,
  isPetOnboardingMainPanelIntent,
  isPetOnboardingReminderMatch,
  isPetOnboardingStateCurrent,
  PET_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_SCENES,
  isPetOnboardingStateForContext,
  selectPetOnboardingStateForContext,
  unwrapPetOnboardingStateResponse,
} from './shared/pet-onboarding-main'
import { parseReminder } from './shared/reminder-parser'
import { getReminderParseFeedback } from './shared/reminder-feedback'
import {
  getBrowserTimeZone,
  getReminderRecurrenceLabel,
} from './shared/reminder-recurrence'
import { createReminder, getPendingReminderSummary } from './shared/reminders-api'
import { DEFAULT_VOICE_SETTINGS, normalizeVoiceSettings, VOICE_OUTPUT_MODES } from './shared/voice-state'

const PET_OPTIONS = ['cat', 'dog', 'pig']

function formatError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    }),
  ])
}

async function logDesktopDebug(payload) {
  try {
    await window.desktopBridge?.logDebug?.(payload)
  } catch {
    // keep silent in renderer; main process handles debug persistence
  }
}

function LanguageSelector({ language, onChange, compact = false }) {
  return (
    <label className={compact ? 'main-header-language' : undefined} style={compact ? undefined : { display: 'grid', gap: 6, minWidth: 164 }}>
      <span className={compact ? 'main-visually-hidden' : undefined} style={compact ? undefined : { fontSize: 12, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
        {t(language, 'language')}
      </span>
      <select className="select" value={language} onChange={(event) => onChange(event.target.value)}>
        {SUPPORTED_LANGUAGES.map((item) => (
          <option key={item.value} value={item.value}>
            {t(language, item.labelKey)}
          </option>
        ))}
      </select>
    </label>
  )
}

function PetRelationshipSummary({ language, petType, relationship, loading, sectionRef }) {
  const stageLabel = relationship
    ? getRelationshipStageLabel(language, relationship.relationship_stage)
    : language === 'zh-CN'
      ? '正在同步'
      : 'Syncing'
  const progress = relationship?.progress || { current: 0, required: 0, percent: 0 }
  const progressText = progress.required > 0
    ? `${progress.current} / ${progress.required}`
    : relationship
      ? language === 'zh-CN'
        ? '已满级'
        : 'Max level'
      : '--'

  return (
    <section
      className={`relationship-summary relationship-summary-${petType}`}
      data-e2e="pet-relationship-summary"
      ref={sectionRef}
      aria-busy={loading}
      aria-label={language === 'zh-CN' ? '宠物亲密度' : 'Pet intimacy'}
    >
      <div className="relationship-heading">
        <div>
          <div className="relationship-label">
            {language === 'zh-CN' ? '亲密度' : 'Intimacy'}
          </div>
          <div className="relationship-level">
            Lv.{relationship?.level ?? '--'}
          </div>
        </div>
        <div className="relationship-stage">{stageLabel}</div>
      </div>
      <div
        className="relationship-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(progress.percent)}
      >
        <div
          className="relationship-progress-value"
          style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
        />
      </div>
      <div className="relationship-progress-copy">
        <span>{progressText}</span>
        <span>{relationship ? `${relationship.intimacy_xp} XP` : ''}</span>
      </div>
    </section>
  )
}

function PetDailySummaryPanel({ language, petType, summary, loading }) {
  if (petType !== 'pig') {
    return null
  }

  const highlights = getPetDailySummaryHighlights(language, summary)
  const metrics = [
    {
      label: language === 'zh-CN' ? '相处' : 'Moments',
      value: summary?.interaction_count,
    },
    {
      label: language === 'zh-CN' ? '完成提醒' : 'Done',
      value: summary?.reminders_completed_count,
    },
    {
      label: language === 'zh-CN' ? '经验' : 'XP',
      value: summary?.xp_gained,
    },
  ]

  return (
    <section
      className="daily-summary-panel"
      aria-busy={loading}
      aria-label={language === 'zh-CN' ? '今日相处' : 'Today together'}
    >
      <div className="daily-summary-heading">
        <div className="relationship-label">
          {language === 'zh-CN' ? '今日相处' : 'Today together'}
        </div>
        <span className="daily-summary-date">{summary?.local_date || ''}</span>
      </div>
      <p className="daily-summary-message">
        {loading && !summary
          ? language === 'zh-CN' ? '正在整理今天的记录…' : 'Gathering today’s moments…'
          : getPetDailySummaryMessage(language, summary)}
      </p>
      <div className="daily-summary-metrics">
        {metrics.map((metric) => (
          <div className="daily-summary-metric" key={metric.label}>
            <strong>{metric.value ?? '--'}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
      {highlights.length > 0 && (
        <div className="daily-summary-highlights">{highlights.join(' · ')}</div>
      )}
    </section>
  )
}

function LoginView({
  apiBaseUrl,
  onApiBaseUrlChange,
  onSaveApiBaseUrl,
  onLoggedIn,
  statusText,
  language,
  onLanguageChange,
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const formRef = useRef(null)
  const [operations] = useState(() => createLoginOperations(cancelLoginAttempt))

  useEffect(() => {
    operations.mount()
    return () => operations.unmount()
  }, [operations])

  const validateFields = (includeCredentials) => {
    const fields = [
      { name: 'server', value: apiBaseUrl.trim(), message: language === 'zh-CN' ? '请输入服务地址。' : 'Enter a service address.' },
      ...(includeCredentials ? [
        { name: 'username', value: username.trim(), message: language === 'zh-CN' ? '请输入用户名或邮箱。' : 'Enter your username or email.' },
        { name: 'password', value: password, message: language === 'zh-CN' ? '请输入密码。' : 'Enter your password.' },
      ] : []),
    ]
    const invalidField = fields.find((field) => !field.value)
    if (!invalidField) return true
    setError(invalidField.message)
    formRef.current?.elements.namedItem(invalidField.name)?.focus()
    return false
  }

  const handleTestConnection = async () => {
    if (!validateFields(false)) return
    const operation = operations.begin()
    if (!operation) return
    setTesting(true)
    setError('')
    try {
      await onSaveApiBaseUrl(apiBaseUrl, operation)
    } catch (connectionError) {
      if (operation.isCurrent()) setError(formatError(connectionError, t(language, 'unableToReachService')))
    } finally {
      if (operation.isCurrent()) setTesting(false)
      operation.finish()
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!validateFields(true)) return
    const operation = operations.begin()
    if (!operation) return
    setLoading(true)
    setError('')

    try {
      const attempt = await onSaveApiBaseUrl(apiBaseUrl, operation)
      operation.assertCurrent()
      const receipt = await login(username, password, { attempt, isCurrent: operation.isCurrent, signal: operation.signal })
      operation.assertCurrent()
      await window.desktopBridge?.showNotification?.({
        title: t(language, 'appName'),
        body: t(language, 'desktopClientLoginSucceeded'),
        loginSession: receipt.session,
        loginServer: receipt.server,
      })
      operation.assertCurrent()
      await onLoggedIn(receipt)
    } catch (loginError) {
      if (operation.isCurrent()) setError(formatError(loginError, t(language, 'loginFailed')))
    } finally {
      if (operation.isCurrent()) setLoading(false)
      operation.finish()
    }
  }

  return (
    <div className="window-shell desktop-login">
      <header className="desktop-login-windowbar">
        <span>Detachym</span>
        <div className="window-titlebar-actions">
          <button type="button" className="main-header-icon" data-e2e="login-minimize" title={t(language, 'minimizeWindow')} aria-label={t(language, 'minimizeWindow')} onClick={() => void window.desktopBridge?.minimizeMainPanel?.()}>
            <Minus size={17} aria-hidden="true" />
          </button>
          <button type="button" className="main-header-icon" data-e2e="login-hide" title={t(language, 'hideWindow')} aria-label={t(language, 'hideWindow')} onClick={() => void window.desktopBridge?.hideMainPanel?.()}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="panel desktop-login-card">
        <div className="desktop-login-meta">
          <span>{t(language, 'desktopAccess')}</span>
          <LanguageSelector language={language} onChange={onLanguageChange} compact />
        </div>
        <div className="desktop-login-brand">
          <img src={getPetVisual('pig', 'happy').image} alt="" />
          <h1>{t(language, 'desktopTitle')}</h1>
        </div>
        <p className="desktop-login-intro">{t(language, 'desktopIntro')}</p>

        <form ref={formRef} onSubmit={handleSubmit}>
          <div className="desktop-login-field">
            <label htmlFor="desktop-login-server">{language === 'zh-CN' ? '服务地址' : 'Service address'}</label>
            <div className="desktop-login-server-row">
              <input
                id="desktop-login-server"
                name="server"
                autoComplete="off"
                required
                aria-describedby={error || statusText ? 'desktop-login-feedback' : undefined}
                className="input"
                data-e2e="login-api-base-url"
                disabled={testing || loading}
                value={apiBaseUrl}
                onChange={(event) => onApiBaseUrlChange(event.target.value)}
                placeholder={t(language, 'serverUrlPlaceholder')}
              />
              <button className="button-secondary" data-e2e="login-test-connection" type="button" onClick={handleTestConnection} disabled={testing || loading}>
                {testing ? t(language, 'testing') : t(language, 'testConnection')}
              </button>
            </div>
          </div>
          <div className="desktop-login-field">
            <label htmlFor="desktop-login-username">{t(language, 'usernameOrEmail')}</label>
            <input
              id="desktop-login-username"
              name="username"
              autoComplete="username"
              required
              aria-describedby={error || statusText ? 'desktop-login-feedback' : undefined}
              className="input"
              data-e2e="login-username"
              disabled={testing || loading}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t(language, 'usernameOrEmail')}
            />
          </div>
          <div className="desktop-login-field">
            <label htmlFor="desktop-login-password">{t(language, 'password')}</label>
            <input
              id="desktop-login-password"
              name="password"
              autoComplete="current-password"
              required
              aria-describedby={error || statusText ? 'desktop-login-feedback' : undefined}
              className="input"
              data-e2e="login-password"
              disabled={testing || loading}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t(language, 'password')}
            />
          </div>
          {(error || statusText) && (
            <div id="desktop-login-feedback" role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true" style={{ color: error ? '#be123c' : '#475569', fontSize: 14 }}>
              {error || statusText}
            </div>
          )}
          <button className="button-primary" data-e2e="login-submit" type="submit" disabled={testing || loading}>
            {loading ? t(language, 'signingIn') : t(language, 'signIn')}
          </button>
        </form>
      </main>
    </div>
  )
}

function PetPreferencePicker({ language, activePetType, onSelect, saving }) {
  return (
    <div className="pet-selector-block">
      <div className="sidebar-title">{t(language, 'petSelection')}</div>
      <div className="sidebar-copy">{t(language, 'petSelectionHint')}</div>
      <div className="pet-option-grid">
        {PET_OPTIONS.map((option) => {
          const petVisual = getPetVisual(option, 'idle')
          const petLabel = t(language, petVisual.labelKey)
          const isActive = option === activePetType

          return (
            <button
              key={option}
              type="button"
              className={`pet-option ${isActive ? 'active' : ''}`}
              data-e2e={`pet-option-${option}`}
              onClick={() => onSelect(option)}
              disabled={saving}
            >
              <img className="pet-option-image" src={petVisual.image} alt={petLabel} />
              <span className="pet-option-label">{petLabel}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function getVoiceModeLabel(language, mode) {
  if (mode === VOICE_OUTPUT_MODES.VOICE_AND_TEXT) {
    return language === 'zh-CN' ? '语音 + 文本' : 'Voice + text'
  }
  return language === 'zh-CN' ? '仅文本' : 'Text only'
}

function formatVoiceShortcut(value) {
  const shortcut = String(value || DEFAULT_VOICE_SETTINGS.desktop_voice_global_shortcut)
  return shortcut.replace('CommandOrControl', 'Ctrl/Command').replace(/\+/g, ' + ')
}

function formatVoiceTriggerKey(value) {
  const key = String(value || DEFAULT_VOICE_SETTINGS.desktop_voice_trigger_key)
  if (/^Key[A-Z]$/.test(key)) {
    return key.slice(3)
  }
  if (/^Digit[0-9]$/.test(key)) {
    return key.slice(5)
  }
  return key
}

function VoiceSettingsPanel({ language, voiceSettings, onEnabledChange, onOutputModeChange, saving }) {
  const title = language === 'zh-CN' ? '语音模式' : 'Voice Mode'
  const enabledLabel = language === 'zh-CN' ? '启用桌宠语音' : 'Enable desktop voice'
  const label = language === 'zh-CN' ? '回复模式' : 'Reply Mode'
  const hint =
    language === 'zh-CN'
      ? '可选择 AI 回复只显示文字，或同时播放语音；桌面语音默认使用语音 + 文本。'
      : 'Choose whether AI replies stay silent or also play audio. Desktop voice defaults to voice + text.'
  const globalShortcutLabel = formatVoiceShortcut(voiceSettings.desktop_voice_global_shortcut)
  const triggerKeyLabel = formatVoiceTriggerKey(voiceSettings.desktop_voice_trigger_key)
  const shortcutHint =
    !voiceSettings.desktop_voice_enabled
      ? language === 'zh-CN'
        ? '桌宠语音已关闭，全局唤起键不会注册。'
        : 'Desktop voice is off, so the global wake shortcut is not registered.'
      : language === 'zh-CN'
        ? `按 ${globalShortcutLabel} 可从任意窗口唤起桌宠语音；进入后按住 ${triggerKeyLabel} 说话。`
        : `Press ${globalShortcutLabel} from anywhere to wake desktop voice, then hold ${triggerKeyLabel} to talk.`

  return (
    <div className="pet-selector-block" style={{ marginTop: 18 }}>
      <div className="sidebar-title">{title}</div>
      <div className="sidebar-copy">{hint}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: '#475569' }}>
        <input
          type="checkbox"
          checked={voiceSettings.desktop_voice_enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          disabled={saving}
        />
        <span>{enabledLabel}</span>
      </label>
      <label style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <span style={{ fontSize: 13, color: '#475569' }}>{label}</span>
        <select
          className="select"
          value={voiceSettings.desktop_voice_output_mode}
          onChange={(event) => onOutputModeChange(event.target.value)}
          disabled={saving || !voiceSettings.desktop_voice_enabled}
        >
          <option value={VOICE_OUTPUT_MODES.TEXT_ONLY}>{getVoiceModeLabel(language, VOICE_OUTPUT_MODES.TEXT_ONLY)}</option>
          <option value={VOICE_OUTPUT_MODES.VOICE_AND_TEXT}>
            {getVoiceModeLabel(language, VOICE_OUTPUT_MODES.VOICE_AND_TEXT)}
          </option>
        </select>
      </label>
      <div style={{ marginTop: 10, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>{shortcutHint}</div>
    </div>
  )
}

const COMPANION_MODE_OPTIONS = [
  COMPANION_MODES.OFF,
  COMPANION_MODES.LOW,
  COMPANION_MODES.STANDARD,
]

function getCompanionModeLabel(language, mode) {
  const labels = {
    'zh-CN': {
      [COMPANION_MODES.OFF]: '关闭',
      [COMPANION_MODES.LOW]: '低频',
      [COMPANION_MODES.STANDARD]: '标准',
    },
    en: {
      [COMPANION_MODES.OFF]: 'Off',
      [COMPANION_MODES.LOW]: 'Low',
      [COMPANION_MODES.STANDARD]: 'Standard',
    },
  }
  return labels[language === 'zh-CN' ? 'zh-CN' : 'en'][mode]
}

function getCompanionStatusLabel(language, statusKey, mood) {
  const labels = {
    'zh-CN': {
      off: '主动陪伴已关闭',
      quiet: '安静陪伴中',
      waiting_return: '在等你回来',
      low_frequency: '低频陪伴中',
      standard: '按日常节律陪伴',
    },
    en: {
      off: 'Proactive moments are off',
      quiet: 'Quiet companionship',
      waiting_return: 'Waiting for you',
      low_frequency: 'Low-frequency companionship',
      standard: 'Following the daily rhythm',
    },
  }
  const moodLabels = {
    'zh-CN': {
      relaxed: '放松',
      expectant: '期待',
      happy: '开心',
      sleepy: '困倦',
      focused: '专注',
    },
    en: {
      relaxed: 'Relaxed',
      expectant: 'Expectant',
      happy: 'Happy',
      sleepy: 'Sleepy',
      focused: 'Focused',
    },
  }
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const status = labels[locale][statusKey] || labels[locale].standard
  const moodLabel = moodLabels[locale][mood]
  return moodLabel ? `${status} · ${moodLabel}` : status
}

function CompanionSettingsPanel({
  language,
  petType,
  settings,
  state,
  onModeChange,
  saving,
}) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (petType !== 'pig') {
      return undefined
    }
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 60000)
    return () => window.clearInterval(timer)
  }, [petType])

  if (petType !== 'pig') {
    return null
  }

  const normalizedSettings = normalizeCompanionSettings(settings)
  const normalizedState = normalizeCompanionState(state)
  const statusKey = getCompanionStatusKey({
    now,
    settings: normalizedSettings,
    state: normalizedState,
  })
  const title = language === 'zh-CN' ? '主动陪伴' : 'Proactive Companion'

  return (
    <section className="companion-panel" aria-labelledby="companion-panel-title">
      <div className="companion-panel-header">
        <div id="companion-panel-title" className="sidebar-title">{title}</div>
        <span className="companion-status-dot" data-status={statusKey} aria-hidden="true" />
      </div>
      <div className="companion-status" role="status">
        {getCompanionStatusLabel(language, statusKey, normalizedState.currentMood)}
      </div>
      <div className="companion-mode-switch" role="group" aria-label={title}>
        {COMPANION_MODE_OPTIONS.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`companion-mode-option ${normalizedSettings.mode === mode ? 'active' : ''}`}
            aria-pressed={normalizedSettings.mode === mode}
            disabled={saving}
            onClick={() => onModeChange(mode)}
          >
            {getCompanionModeLabel(language, mode)}
          </button>
        ))}
      </div>
    </section>
  )
}

function MainPanelApp() {
  const [initialized, setInitialized] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [user, setUser] = useState(null)
  const [tab, setTab] = useState('chat')
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const conversationRef = useRef({ sessionId: null, selecting: false, pending: new Map(), revision: 0 })
  const updateActiveSessionId = (sessionId) => {
    conversationRef.current.sessionId = sessionId
    setActiveSessionId(sessionId)
  }
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [reminderDraftError, setReminderDraftError] = useState(null)
  const promptInputRef = useRef(null)
  const [useRag, setUseRag] = useState(true)
  const [documents, setDocuments] = useState([])
  const [knowledgeBusy, setKnowledgeBusy] = useState(false)
  const knowledgeMutationRef = useRef(null)
  const knowledgeFileRef = useRef(null)
  const [statusText, setStatusText] = useState('')
  const [knowledgeStatusText, setKnowledgeStatusText] = useState('')
  const [knowledgeSources, setKnowledgeSources] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectingSession, setSelectingSession] = useState(false)
  const [newChatVersion, setNewChatVersion] = useState(0)
  const [savingPet, setSavingPet] = useState(false)
  const [savingOutfit, setSavingOutfit] = useState(false)
  const [savingVoiceSettings, setSavingVoiceSettings] = useState(false)
  const [savingCompanionSettings, setSavingCompanionSettings] = useState(false)
  const [apiBaseUrl, setApiBaseUrlState] = useState('')
  const [language, setLanguageState] = useState('zh-CN')
  const [voiceSettings, setVoiceSettingsState] = useState(DEFAULT_VOICE_SETTINGS)
  const [companionSettings, setCompanionSettingsState] = useState(DEFAULT_COMPANION_SETTINGS)
  const [companionState, setCompanionState] = useState(DEFAULT_COMPANION_STATE)
  const [petRelationship, setPetRelationship] = useState(null)
  const [petRelationshipLoading, setPetRelationshipLoading] = useState(false)
  const [petRelationshipError, setPetRelationshipError] = useState(false)
  const [readyRelationshipContext, setReadyRelationshipContext] = useState(null)
  const [petDailySummary, setPetDailySummary] = useState(null)
  const [petDailySummaryLoading, setPetDailySummaryLoading] = useState(false)
  const [petOnboardingState, setPetOnboardingState] = useState(null)
  const [petOnboardingBusy, setPetOnboardingBusy] = useState(false)
  const [petOnboardingError, setPetOnboardingError] = useState('')
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible')
  const [onboardingClock, setOnboardingClock] = useState(() => Date.now())
  const [intentOverride, setIntentOverride] = useState(null)
  const [focusNavigationVersion, setFocusNavigationVersion] = useState(0)
  const pendingFocusNavigationRef = useRef(false)
  const tabRef = useRef('chat')
  const intentOverrideRef = useRef(null)
  const intentConsumerRef = useRef(null)
  const relationshipRequestRef = useRef(0)
  const dailySummaryRequestRef = useRef(0)
  const accountRequestEpochRef = useRef(0)
  const activeSessionTokenRef = useRef(null)
  const activeSessionSnapshotRef = useRef(null)
  const activeAuthoritativeContextRef = useRef(null)
  const knowledgeSelectGateRef = useRef(null)
  const sessionListGateRef = useRef(null)
  const knowledgeUploadGateRef = useRef(null)
  const knowledgeDeleteGateRef = useRef(null)
  const companionLoadGateRef = useRef(null)
  if (!knowledgeSelectGateRef.current) knowledgeSelectGateRef.current = createAccountOperationGate()
  if (!sessionListGateRef.current) sessionListGateRef.current = createAccountOperationGate()
  if (!knowledgeUploadGateRef.current) knowledgeUploadGateRef.current = createAccountOperationGate()
  if (!knowledgeDeleteGateRef.current) knowledgeDeleteGateRef.current = createAccountOperationGate()
  if (!companionLoadGateRef.current) companionLoadGateRef.current = createAccountOperationGate()
  const activeUserIdRef = useRef(null)
  const activePetTypeRef = useRef('cat')
  const relationshipSummaryRef = useRef(null)
  const petOnboardingCardRef = useRef(null)
  const authenticatedRef = useRef(false)
  const relationshipObservationContextRef = useRef(null)
  const petOnboardingContextKeyRef = useRef(null)
  const petOnboardingContextRef = useRef({
    userId: null,
    relationshipId: null,
    petType: 'cat',
  })
  const petOnboardingStateRef = useRef(null)
  tabRef.current = tab

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )
  const currentPetType = user?.preferences?.pet_type ?? 'cat'
  const reminderDraftFeedback = getReminderParseFeedback(reminderDraftError, language)
  useEffect(() => { setReminderDraftError(null) }, [prompt, currentPetType, activeSessionId])
  const currentPetLabel = useMemo(() => t(language, getPetVisual(currentPetType, 'idle').labelKey), [currentPetType, language])
  const petOnboardingContextKey = useMemo(() => createPetOnboardingContextKey({
    userId: user?.id,
    relationshipId: petRelationship?.id,
    petType: currentPetType,
  }), [currentPetType, petRelationship?.id, user?.id])
  petOnboardingContextKeyRef.current = petOnboardingContextKey
  petOnboardingContextRef.current = {
    userId: user?.id,
    relationshipId: petRelationship?.id,
    petType: currentPetType,
  }
  petOnboardingStateRef.current = petOnboardingState
  activeUserIdRef.current = user?.id ?? null
  activePetTypeRef.current = currentPetType
  authenticatedRef.current = authenticated
  const intentOverrideIsCurrent = Boolean(
    intentOverride
    && authenticated
    && Number(intentOverride.semantic?.userId) === Number(user?.id)
    && intentOverride.semantic?.petType === currentPetType
    && Number(intentOverride.semantic?.relationshipId) === Number(petRelationship?.id)
  )
  const effectiveTab = intentOverrideIsCurrent ? 'chat' : tab
  const petDataReady = Boolean(
    authenticated
    && readyRelationshipContext
    && readyRelationshipContext.epoch === accountRequestEpochRef.current
    && Number(readyRelationshipContext.userId) === Number(user?.id)
    && readyRelationshipContext.petType === currentPetType
    && isSessionSnapshotCurrent(readyRelationshipContext.session, activeSessionSnapshotRef.current)
  )

  useEffect(() => {
    if (!pendingFocusNavigationRef.current || !authenticated || effectiveTab !== 'chat' || currentPetType !== 'pig') return undefined
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector('[data-e2e="focus-panel"]')
        || document.querySelector('[data-e2e="companion-sync-retry"]')
      if (!target) return
      pendingFocusNavigationRef.current = false
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
      target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [authenticated, currentPetType, effectiveTab, focusNavigationVersion, petDataReady, petRelationshipError])

  useEffect(() => {
    pendingFocusNavigationRef.current = false
  }, [authenticated, currentPetType, user?.id])

  useEffect(() => window.desktopBridge?.e2e?.onSnapshot?.(() => ({
    authenticated: authenticatedRef.current,
    userId: activeUserIdRef.current,
    petType: activePetTypeRef.current,
    relationshipId: petOnboardingContextRef.current.relationshipId,
    tab: tabRef.current,
  })), [])

  if (!intentConsumerRef.current) {
    intentConsumerRef.current = createMainPanelIntentConsumerController({
      getState: () => ({
        authenticated: authenticatedRef.current,
        userId: activeUserIdRef.current,
        petType: activePetTypeRef.current,
        relationshipId: petOnboardingContextRef.current.relationshipId,
        activeCapabilityId: activeAuthoritativeContextRef.current?.id,
        tab: tabRef.current,
      }),
      validateCapability: (capability, requiredScope, semantic) => (
        window.desktopBridge?.validateOperationContext?.(capability, requiredScope, semantic)
      ),
      showOverride: (payload) => new Promise((resolve) => {
        intentOverrideRef.current = payload
        setIntentOverride(payload)
        window.requestAnimationFrame(() => {
          resolve(
            intentOverrideRef.current?.id === payload.id
              ? (petOnboardingCardRef.current || relationshipSummaryRef.current)
              : null,
          )
        })
      }),
      clearOverride: (id) => {
        if (intentOverrideRef.current?.id !== id) return
        intentOverrideRef.current = null
        setIntentOverride((current) => current?.id === id ? null : current)
      },
      acknowledge: (id) => window.desktopBridge?.ackMainPanelIntent?.(id),
      commitTab: (nextTab) => {
        tabRef.current = nextTab
        setTab(nextTab)
      },
    })
  }

  const getExpectedOnboardingAccountContext = () => ({
    hasSession: Boolean(activeSessionTokenRef.current),
    userId: petOnboardingContextRef.current.userId,
    relationshipId: petOnboardingContextRef.current.relationshipId,
    petType: petOnboardingContextRef.current.petType,
    session: activeSessionSnapshotRef.current,
    authoritative: activeAuthoritativeContextRef.current,
  })

  useEffect(() => {
    setPetOnboardingBusy(false)
    setPetOnboardingError('')
    relationshipObservationContextRef.current = null
  }, [petOnboardingContextKey])

  useEffect(() => {
    if (
      petOnboardingState
      && !isPetOnboardingStateForContext(petOnboardingState, petOnboardingContextRef.current)
    ) {
      setPetOnboardingState(null)
      setPetOnboardingError('')
    }
  }, [petOnboardingContextKey, petOnboardingState])

  const petOnboardingIsCurrent = useMemo(() => isPetOnboardingStateCurrent({
    authenticated,
    petType: currentPetType,
    userId: user?.id,
    relationship: petRelationship,
    state: petOnboardingState,
    documentVisible,
    now: new Date(onboardingClock),
  }), [
    authenticated,
    currentPetType,
    documentVisible,
    onboardingClock,
    petOnboardingState,
    petRelationship,
    user?.id,
  ])
  const petOnboardingScene = petOnboardingIsCurrent
    ? derivePetOnboardingScene(petOnboardingState)
    : null

  const updateLanguage = async (nextLanguage) => {
    const savedLanguage = await setLanguage(nextLanguage)
    setLanguageState(normalizeLanguage(savedLanguage))
  }

  const commitPetOnboardingResponse = useCallback((response, expectedContextKey) => {
    const currentContextKey = petOnboardingContextKeyRef.current
    if (
      expectedContextKey !== undefined
      && expectedContextKey !== currentContextKey
    ) {
      return null
    }
    const nextState = selectPetOnboardingStateForContext(
      petOnboardingStateRef.current,
      response,
      petOnboardingContextRef.current,
    )
    petOnboardingStateRef.current = nextState
    setPetOnboardingState(nextState)
    setPetOnboardingError('')
    setOnboardingClock(Date.now())
    return nextState
  }, [])

  const refreshPetOnboardingStateForContext = useCallback(async (expectedContextKey) => {
    if (
      !expectedContextKey
      || expectedContextKey !== petOnboardingContextKeyRef.current
    ) {
      return null
    }
    try {
      const state = await window.desktopBridge?.getPetOnboardingState?.(
        'pig',
        getExpectedOnboardingAccountContext(),
      )
      return commitPetOnboardingResponse(state, expectedContextKey)
    } catch (error) {
      await logDesktopDebug({
        event: 'main-panel-onboarding-state-refresh-failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }, [commitPetOnboardingResponse])

  const applyPetOnboardingResponse = useCallback((response, expectedContextKey) => {
    if (response?.ok === false) {
      void refreshPetOnboardingStateForContext(expectedContextKey)
      return petOnboardingStateRef.current
    }
    return commitPetOnboardingResponse(response, expectedContextKey)
  }, [commitPetOnboardingResponse, refreshPetOnboardingStateForContext])

  useEffect(() => {
    if (!petOnboardingContextKey) {
      return undefined
    }
    let active = true
    const expectedContextKey = petOnboardingContextKey
    const refreshStateForContext = async () => {
      try {
        const state = await window.desktopBridge?.getPetOnboardingState?.(
          'pig',
          getExpectedOnboardingAccountContext(),
        )
        if (active) {
          applyPetOnboardingResponse(state, expectedContextKey)
        }
      } catch (error) {
        await logDesktopDebug({
          event: 'main-panel-onboarding-context-refresh-failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    void refreshStateForContext()
    return () => {
      active = false
    }
  }, [applyPetOnboardingResponse, petOnboardingContextKey])

  const getCurrentMainPanelAccountContext = () => ({
    hasSession: Boolean(activeSessionTokenRef.current),
    userId: activeUserIdRef.current,
    petType: activePetTypeRef.current,
    session: activeSessionSnapshotRef.current,
    authoritative: activeAuthoritativeContextRef.current,
    relationshipId: activeAuthoritativeContextRef.current?.relationshipId
      ?? petOnboardingContextRef.current.relationshipId
      ?? null,
  })

  const isMainPanelAccountRequestCurrent = (requestContext) => (
    requestContext?.epoch === accountRequestEpochRef.current
    && isSessionSnapshotCurrent(requestContext?.session, activeSessionSnapshotRef.current)
    && isPetAccountOperationCurrent(
      requestContext,
      getCurrentMainPanelAccountContext(),
    )
  )

  const loadPetRelationship = async (petType) => {
    const requestId = relationshipRequestRef.current + 1
    relationshipRequestRef.current = requestId
    const requestContext = {
      ...getCurrentMainPanelAccountContext(),
      petType,
      // The destination relationship is what this request discovers. During a
      // pet switch React may still hold the previous pet's relationship id.
      relationshipId: null,
      epoch: accountRequestEpochRef.current,
      session: activeSessionSnapshotRef.current,
    }
    setPetRelationshipLoading(true)
    setPetRelationshipError(false)

    let cachedRelationship = null
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      if (
        relationshipRequestRef.current !== requestId
        || !isMainPanelAccountRequestCurrent(requestContext)
      ) return false
      cachedRelationship = normalizePetRelationship(
        await window.desktopBridge?.getCachedPetRelationship?.(petType, operationContext),
        petType,
      )
      if (
        relationshipRequestRef.current !== requestId
        || !isMainPanelAccountRequestCurrent(requestContext)
      ) return false
      if (
        cachedRelationship
        && relationshipRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
        && Number(cachedRelationship.user_id) === Number(requestContext.userId)
      ) {
        setPetRelationship(cachedRelationship)
      }

      const remoteRelationship = await getPetRelationship(petType, operationContext)
      if (
        relationshipRequestRef.current !== requestId
        || !isMainPanelAccountRequestCurrent(requestContext)
      ) {
        return false
      }
      if (
        Number(remoteRelationship?.user_id) !== Number(requestContext.userId)
        || remoteRelationship?.pet_type !== requestContext.petType
      ) throw new Error('relationship_context_mismatch')
      setPetRelationship(remoteRelationship)
      const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
        remoteRelationship,
        operationContext,
      )
      if (
        relationshipRequestRef.current !== requestId
        || !isMainPanelAccountRequestCurrent(requestContext)
      ) {
        return false
      }
      if (
        !cacheResult?.ok
        || !cacheResult.authoritative
        || Number(cacheResult.relationship?.id) !== Number(remoteRelationship.id)
        || Number(cacheResult.relationship?.user_id) !== Number(requestContext.userId)
      ) throw new Error('relationship_cache_unavailable')
      activeAuthoritativeContextRef.current = cacheResult.authoritative
      setReadyRelationshipContext(requestContext)
      setPetRelationshipError(false)
      return true
    } catch (error) {
      if (
        relationshipRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        if (!cachedRelationship) setPetRelationship(null)
        setPetRelationshipError(true)
      }
      await logDesktopDebug({
        event: 'main-panel-relationship-load-failed',
        petType,
        reason: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      if (
        relationshipRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        setPetRelationshipLoading(false)
      }
    }
  }

  useEffect(() => window.desktopBridge?.e2e?.onRelationshipRefresh?.(() => (
    loadPetRelationship(activePetTypeRef.current)
  )), [])

  const loadPetDailySummary = async (petType) => {
    const requestId = dailySummaryRequestRef.current + 1
    dailySummaryRequestRef.current = requestId
    const requestContext = {
      ...getCurrentMainPanelAccountContext(),
      petType,
      epoch: accountRequestEpochRef.current,
      session: activeSessionSnapshotRef.current,
    }
    setPetDailySummaryLoading(true)
    try {
      const summary = await getPetDailySummary(petType, requestContext)
      if (
        dailySummaryRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        setPetDailySummary(summary)
      }
    } catch (error) {
      if (
        dailySummaryRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        setPetDailySummary(null)
      }
      await logDesktopDebug({
        event: 'main-panel-daily-summary-load-failed',
        petType,
        reason: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (
        dailySummaryRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        setPetDailySummaryLoading(false)
      }
    }
  }

  const loadDashboard = async (loginReceipt = null) => {
    if (loginReceipt && (
      !isSessionSnapshotCurrent(loginReceipt.session, await getSessionSnapshot())
      || loginReceipt.server !== await getApiBaseUrl()
    )) return false
    const requestEpoch = accountRequestEpochRef.current + 1
    accountRequestEpochRef.current = requestEpoch
    const operationContext = await captureApiOperationContext({
      epoch: requestEpoch,
      ...(loginReceipt ? { session: loginReceipt.session, server: loginReceipt.server } : {}),
    }, 'account')
    const expectedToken = operationContext?.session?.token
    if (!expectedToken) {
      return false
    }
    const [me, sessionList, documentList] = await Promise.all([
      desktopApi.me(operationContext),
      desktopApi.getSessions(operationContext),
      desktopApi.getDocuments(operationContext),
    ])
    const currentSession = await getSessionSnapshot()
    if (
      accountRequestEpochRef.current !== requestEpoch
      || !isSessionSnapshotCurrent(operationContext.session, currentSession)
    ) {
      return false
    }

    activeSessionTokenRef.current = expectedToken
    activeSessionSnapshotRef.current = operationContext.session
    activeUserIdRef.current = me?.id ?? null
    activePetTypeRef.current = me?.preferences?.pet_type || 'cat'
    const synchronizedState = await window.desktopBridge?.syncPetState?.({
      source: 'main-panel',
      hasSession: true,
      userId: me?.id ?? null,
      petType: me?.preferences?.pet_type || 'cat',
      preferences: me?.preferences || {},
      language,
      expectedSession: operationContext.session,
      expectedContext: operationContext.authoritative,
    })
    const synchronizedCapability = synchronizedState?.authoritative
    if (
      accountRequestEpochRef.current !== requestEpoch
      || !isSessionSnapshotCurrent(operationContext.session, activeSessionSnapshotRef.current)
    ) {
      return false
    }
    if (!synchronizedState?.ok || !synchronizedCapability) {
      throw new Error(language === 'zh-CN'
        ? '暂时无法同步桌宠状态，请重新登录后再试。'
        : 'Unable to sync your companion. Please sign in again.')
    }
    activeAuthoritativeContextRef.current = synchronizedCapability
    // Child panels can request account-bound data as soon as they mount.
    // Publish the dashboard only after the main process has synchronized it.
    activeUserIdRef.current = me?.id ?? null
    activePetTypeRef.current = me?.preferences?.pet_type || 'cat'
    setUser(me)
    setSessions(sessionList)
    setDocuments(documentList)
    updateActiveSessionId(sessionList[0]?.id ?? null)
    setMessages(sessionList[0]?.messages || [])
    setAuthenticated(true)
    // List rows are summaries. Restore only the newest conversation, without
    // making its optional history read a prerequisite for account recovery.
    if (sessionList[0]?.id) void handleSelectSession(sessionList[0].id)
    // The first relationship cache write consumes the shared pet capability.
    // Finish that transition before child panels derive their read capabilities.
    const relationshipReady = await loadPetRelationship(me?.preferences?.pet_type || 'cat')
    if (
      accountRequestEpochRef.current !== requestEpoch
      || !isSessionSnapshotCurrent(operationContext.session, activeSessionSnapshotRef.current)
    ) return false
    if (relationshipReady) void loadPetDailySummary(me?.preferences?.pet_type || 'cat')
    await logDesktopDebug({
      event: 'main-panel-load-dashboard',
      petType: me?.preferences?.pet_type || 'cat',
      sessionCount: sessionList.length,
    })
    return true
  }

  const handleSaveApiBaseUrl = async (requestedUrl, operation) => {
    const attempt = operation.ownAttempt(await beginLoginAttempt(requestedUrl))
    const verifiedApiBaseUrl = await checkApiConnection(attempt.server, { signal: operation.signal })
    operation.assertCurrent()
    await setApiBaseUrl(verifiedApiBaseUrl, attempt)
    operation.assertCurrent()
    setApiBaseUrlState(verifiedApiBaseUrl)
    setStatusText(t(language, 'serverConnectionVerified'))
    return attempt
  }

  const handleShowPet = async () => {
    await window.desktopBridge?.showPet?.()
    await logDesktopDebug({ event: 'main-panel-show-pet' })
    setStatusText(t(language, 'petShown'))
  }

  const handleResetPetPosition = async () => {
    await window.desktopBridge?.resetPetPosition?.()
    await logDesktopDebug({ event: 'main-panel-reset-pet-position' })
    setStatusText(t(language, 'petPositionReset'))
  }

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const [savedApiBaseUrl, token, savedLanguage] = await Promise.all([
          getApiBaseUrl(),
          getSessionToken(),
          getLanguage(),
        ])
        const [savedVoiceSettings, savedCompanionSettings] = await Promise.all([
          getVoiceSettings(),
          getCompanionSettings(),
        ])

        if (active) {
          setApiBaseUrlState(savedApiBaseUrl || '')
          setLanguageState(normalizeLanguage(savedLanguage))
          setVoiceSettingsState(normalizeVoiceSettings(savedVoiceSettings))
          setCompanionSettingsState(normalizeCompanionSettings(savedCompanionSettings))
        }

        if (!token || !savedApiBaseUrl) {
          return
        }

        await loadDashboard()
        await logDesktopDebug({ event: 'main-panel-runtime-ready' })
      } catch (error) {
        if (active) {
          setAuthenticated(false)
          setStatusText(formatError(error, t(language, 'unableToReachService')))
        }
      } finally {
        if (active) {
          setInitialized(true)
        }
      }
    }

    void bootstrap()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === 'visible')
      setOnboardingClock(Date.now())
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    // A mounted renderer is not yet ready to consume account-bound navigation.
    // Cached relationship data arrives before its capability transition settles.
    // Wait for the same gate that mounts the target cards: announcing readiness
    // earlier would consume an intent while its scroll target is still absent.
    if (
      !authenticated
      || !petDataReady
      || !user?.id
      || !petRelationship?.id
      || Number(petRelationship.user_id) !== Number(user.id)
      || petRelationship.pet_type !== currentPetType
    ) return undefined
    const unsubscribe = window.desktopBridge?.onMainPanelIntent?.((payload) => {
      if (!isPetOnboardingMainPanelIntent(payload)) {
        return false
      }
      return intentConsumerRef.current.consume(payload)
    })
    return () => unsubscribe?.()
  }, [authenticated, petDataReady, user?.id, currentPetType, petRelationship?.id, petRelationship?.user_id, petRelationship?.pet_type])

  useEffect(() => {
    intentConsumerRef.current.cancel()
  }, [authenticated, user?.id, currentPetType, petRelationship?.id])

  useEffect(() => {
    let active = true
    const unsubscribe = window.desktopBridge?.onPetOnboardingChanged?.((state) => {
      if (active) {
        const currentContextKey = petOnboardingContextKeyRef.current
        const nextState = unwrapPetOnboardingStateResponse(state)
        if (nextState && isPetOnboardingStateForContext(nextState, petOnboardingContextRef.current)) {
          applyPetOnboardingResponse(nextState, currentContextKey)
        } else if (!nextState && !currentContextKey) {
          setPetOnboardingState(null)
        }
      }
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [applyPetOnboardingResponse])

  useEffect(() => {
    const snoozedUntil = Date.parse(petOnboardingState?.snoozed_until || '')
    if (!Number.isFinite(snoozedUntil) || snoozedUntil <= Date.now()) {
      return undefined
    }
    const delay = Math.min(snoozedUntil - Date.now() + 25, 2_147_483_647)
    const timer = window.setTimeout(() => setOnboardingClock(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [petOnboardingState?.snoozed_until])

  useEffect(() => {
    if (
      !petDataReady
      || !petOnboardingIsCurrent
      || effectiveTab !== 'chat'
      || petOnboardingScene !== PET_ONBOARDING_SCENES.RELATIONSHIP
      || !relationshipSummaryRef.current
      || relationshipObservationContextRef.current === petOnboardingContextKey
    ) {
      return undefined
    }

    let observer = null
    let disposed = false
    const recordRelationshipViewed = async () => {
      if (
        disposed
        || relationshipObservationContextRef.current === petOnboardingContextKey
      ) {
        return
      }
      relationshipObservationContextRef.current = petOnboardingContextKey
      const expectedContextKey = petOnboardingContextKeyRef.current
      try {
        const result = await window.desktopBridge?.recordPetOnboardingObservation?.(
          'pig',
          PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
          {},
          getExpectedOnboardingAccountContext(),
        )
        if (result === undefined) {
          throw new Error('onboarding_bridge_unavailable')
        }
        if (result?.ok === false) {
          applyPetOnboardingResponse(result, expectedContextKey)
          throw new Error(result.reason || 'relationship_observation_rejected')
        }
        applyPetOnboardingResponse(result, expectedContextKey)
      } catch (error) {
        await logDesktopDebug({
          event: 'main-panel-onboarding-relationship-observation-failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (
          petOnboardingContextKeyRef.current !== expectedContextKey
          || !petOnboardingStateRef.current?.observed_capability_ids?.includes(
            PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
          )
        ) {
          relationshipObservationContextRef.current = null
        }
      }
    }

    if (typeof window.IntersectionObserver === 'function') {
      observer = new window.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) {
          observer?.disconnect()
          void recordRelationshipViewed()
        }
      })
      observer.observe(relationshipSummaryRef.current)
    } else {
      void recordRelationshipViewed()
    }

    return () => {
      disposed = true
      observer?.disconnect()
    }
  }, [
    applyPetOnboardingResponse,
    petDataReady,
    petOnboardingIsCurrent,
    petOnboardingContextKey,
    petOnboardingScene,
    petRelationship,
    effectiveTab,
  ])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetRelationshipChanged?.((payload) => {
      if (payload === null || payload === undefined) {
        const runtimeReset = createMainPanelRelationshipNullReset()
        accountRequestEpochRef.current += 1
        relationshipRequestRef.current += 1
        dailySummaryRequestRef.current += 1
        activeSessionTokenRef.current = null
        activeSessionSnapshotRef.current = null
        activeAuthoritativeContextRef.current = null
        activeUserIdRef.current = null
        activePetTypeRef.current = 'cat'
        setAuthenticated(false)
        setUser(null)
        setSessions([])
        conversationRef.current.pending.clear()
        conversationRef.current.selecting = false
        updateActiveSessionId(null)
        setMessages([])
        setPrompt('')
        setSelectingSession(false)
        knowledgeSelectGateRef.current.invalidate()
        setDocuments([])
        knowledgeMutationRef.current = null
        setKnowledgeBusy(false)
        setLoading(false)
        setSavingPet(runtimeReset.savingPet)
        setSavingOutfit(runtimeReset.savingOutfit)
        setSavingCompanionSettings(runtimeReset.savingCompanionSettings)
        setPetRelationshipLoading(runtimeReset.petRelationshipLoading)
        setPetDailySummaryLoading(runtimeReset.petDailySummaryLoading)
        setPetOnboardingBusy(runtimeReset.petOnboardingBusy)
        setPetOnboardingError(runtimeReset.petOnboardingError)
        setCompanionState(DEFAULT_COMPANION_STATE)
        setReadyRelationshipContext(null)
        setPetRelationshipError(false)
        setPetRelationship(null)
        setPetDailySummary(null)
        setPetOnboardingState(null)
        return
      }
      void (async () => {
        const requestContext = {
          ...getCurrentMainPanelAccountContext(),
          epoch: accountRequestEpochRef.current,
        }
        const adopted = await adoptRelationshipCapability({
          payload,
          currentContext: requestContext,
          validateCapability: (capability, requiredScope, semantic) => (
            window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
          ),
        })
        if (!adopted || !isMainPanelAccountRequestCurrent(requestContext)) return
        const relationship = normalizePetRelationship(adopted.relationship, currentPetType)
        activeAuthoritativeContextRef.current = adopted.authoritative
        setReadyRelationshipContext({
          ...getCurrentMainPanelAccountContext(),
          epoch: accountRequestEpochRef.current,
        })
        setPetRelationshipError(false)
        setPetRelationship(relationship)
        void loadPetDailySummary(currentPetType)
      })()
    })
    return () => unsubscribe?.()
  }, [currentPetType])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onVoiceSettingsChanged?.((payload) => {
      setVoiceSettingsState(normalizeVoiceSettings(payload))
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (!authenticated || !petDataReady) return undefined
    let mounted = true
    const loadCompanionState = async () => {
      try {
        const operationContext = await captureApiOperationContext(
          getCurrentMainPanelAccountContext(),
          'pet',
        )
        const requestContext = companionLoadGateRef.current.begin(operationContext)
        await runAccountOperation({
          gate: companionLoadGateRef.current,
          requestContext,
          getCurrentContext: () => mounted ? getCurrentMainPanelAccountContext() : null,
          operation: () => window.desktopBridge?.getCompanionState?.(
            currentPetType,
            operationContext,
          ),
          onSuccess: (savedState) => setCompanionState(normalizeCompanionState(savedState)),
          onError: (error) => {
            void logDesktopDebug({
              event: 'main-panel-companion-state-load-failed',
              petType: currentPetType,
              reason: error instanceof Error ? error.message : String(error),
            })
          },
        })
      } catch (error) {
        if (mounted) {
          await logDesktopDebug({
            event: 'main-panel-companion-state-load-failed',
            petType: currentPetType,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    void loadCompanionState()
    return () => {
      mounted = false
      companionLoadGateRef.current.invalidate()
    }
  }, [
    authenticated,
    petDataReady,
    currentPetType,
    user?.id,
    activeSessionSnapshotRef.current?.generation,
    accountRequestEpochRef.current,
  ])

  useEffect(() => {
    const unsubscribeSettings = window.desktopBridge?.onCompanionSettingsChanged?.((payload) => {
      setCompanionSettingsState(normalizeCompanionSettings(payload))
    })
    const unsubscribeState = window.desktopBridge?.onCompanionStateChanged?.((payload) => {
      if (payload?.cleared) {
        setCompanionState(DEFAULT_COMPANION_STATE)
        return
      }
      if (
        payload?.pet_type === currentPetType
        && Number(payload?.user_id) === Number(activeUserIdRef.current)
      ) {
        setCompanionState(normalizeCompanionState(payload.state))
      }
    })

    return () => {
      unsubscribeSettings?.()
      unsubscribeState?.()
    }
  }, [currentPetType])

  useEffect(() => {
    let mounted = true
    const emitHeartbeat = async (kind) => {
      if (!mounted) {
        return
      }
      await window.desktopBridge?.sendRendererHeartbeat?.({
        kind,
        view: 'main-panel',
        initialized,
        authenticated,
        tab,
        currentPetType,
        activeSessionId,
        sessionCount: sessions.length,
        messageCount: messages.length,
        savingPet,
        savingOutfit,
        savingCompanionSettings,
        loading,
        useRag,
      })
    }

    void emitHeartbeat('mounted')
    const timer = window.setInterval(() => {
      void emitHeartbeat('interval')
    }, 8000)

    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [
    initialized,
    authenticated,
    tab,
    currentPetType,
    activeSessionId,
    sessions.length,
    messages.length,
    savingPet,
    savingOutfit,
    savingCompanionSettings,
    loading,
    useRag,
  ])

  const handleSend = async () => {
    if (!prompt.trim() || loading || selectingSession) {
      return
    }

    const outgoingMessage = prompt.trim()
    setReminderDraftError(null)
    const conversationRequest = knowledgeSelectGateRef.current.begin({
      ...getCurrentMainPanelAccountContext(),
      epoch: accountRequestEpochRef.current,
    })
    const isConversationCurrent = () => (
      isMainPanelAccountRequestCurrent(conversationRequest)
      && knowledgeSelectGateRef.current.isCurrent(conversationRequest, getCurrentMainPanelAccountContext())
    )
    const parsedReminder = parseReminder(outgoingMessage)
    if (parsedReminder.ok) {
      const reminderUserIdAtSend = user?.id
      const reminderPetTypeAtSend = currentPetType
      const reminderRequestContext = {
        ...getCurrentMainPanelAccountContext(),
        relationshipId: petOnboardingContextRef.current.relationshipId,
        epoch: accountRequestEpochRef.current,
        session: activeSessionSnapshotRef.current,
      }
      setPrompt('')
      setLoading(true)
      setStatusText(t(language, 'waitingResponse'))
      setKnowledgeStatusText('')
      setKnowledgeSources([])
      let reminderCreated = false
      try {
        const reminder = await createReminder({
          pet_type: reminderPetTypeAtSend,
          title: parsedReminder.title,
          source_text: parsedReminder.sourceText,
          remind_at: parsedReminder.remindAt.toISOString(),
          recurrence_type: parsedReminder.recurrenceType,
          recurrence_timezone: parsedReminder.recurrenceType === 'once'
            ? null
            : getBrowserTimeZone(),
        }, reminderRequestContext)
        reminderCreated = true
        if (
          !isMainPanelAccountRequestCurrent(reminderRequestContext)
          || Number(reminder.user_id) !== Number(reminderRequestContext.userId)
        ) {
          return
        }
        const confirmedRemindAt = new Date(reminder.remind_at)
        const timeText = confirmedRemindAt.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        const copy = getPetReminderCopy(reminderPetTypeAtSend).createdReminder(
          reminder.title,
          timeText,
          reminder.email_enabled,
          getReminderRecurrenceLabel(
            reminder.recurrence_type,
            reminder.remind_at,
            language,
          ),
        )
        if (isConversationCurrent()) {
          setMessages((current) => [
            ...current,
            { role: 'user', content: outgoingMessage },
            { role: 'assistant', content: copy },
          ])
          setStatusText(copy)
        }
        window.dispatchEvent(new Event('detachym:reminders-changed'))
        if (reminder.series_id) {
          window.dispatchEvent(new Event('detachym:reminder-series-changed'))
        }
        if (
          reminderPetTypeAtSend === 'pig'
          && petOnboardingContextRef.current.petType === reminderPetTypeAtSend
          && Number(petOnboardingContextRef.current.userId) === Number(reminderUserIdAtSend)
          && Number(reminder.user_id) === Number(reminderUserIdAtSend)
        ) {
          const expectedContextKey = petOnboardingContextKeyRef.current
          const onboardingResult = await window.desktopBridge?.recordPetOnboardingObservation?.(
            'pig',
            PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
            { reminderId: reminder.id },
            reminderRequestContext,
          )
          if (!isMainPanelAccountRequestCurrent(reminderRequestContext)) {
            return
          }
          if (onboardingResult !== undefined) {
            applyPetOnboardingResponse(onboardingResult, expectedContextKey)
          }
          if (onboardingResult === undefined || onboardingResult?.ok === false) {
            await logDesktopDebug({
              event: 'main-panel-onboarding-reminder-observation-rejected',
              reason: onboardingResult?.reason || 'onboarding_bridge_unavailable',
              reminderId: reminder.id,
            })
            if (!isMainPanelAccountRequestCurrent(reminderRequestContext)) {
              return
            }
          }
        }
        void getPetRelationship(reminderPetTypeAtSend, reminderRequestContext).then(async (nextRelationship) => {
          if (
            isMainPanelAccountRequestCurrent(reminderRequestContext)
            &&
            petOnboardingContextRef.current.petType === reminderPetTypeAtSend
            && Number(petOnboardingContextRef.current.userId) === Number(reminderUserIdAtSend)
            && Number(nextRelationship?.user_id) === Number(reminderUserIdAtSend)
          ) {
            await window.desktopBridge?.cachePetRelationship?.(nextRelationship, reminderRequestContext)
          }
        }).catch((error) => {
          void logDesktopDebug({
            event: 'main-panel-relationship-refresh-failed',
            source: 'reminder-created',
            reason: error instanceof Error ? error.message : String(error),
          })
        })
        if (!isMainPanelAccountRequestCurrent(reminderRequestContext)) {
          return
        }
        void loadPetDailySummary(reminderPetTypeAtSend)
        await window.desktopBridge?.notifyPetReminderEvent?.({
          type: 'created',
          petType: reminderPetTypeAtSend,
          title: reminder.title,
          message: copy,
          reminderId: reminder.id,
        }, reminderRequestContext)
        if (!isMainPanelAccountRequestCurrent(reminderRequestContext)) {
          return
        }
      } catch (error) {
        if (isConversationCurrent() && !reminderCreated) {
          setPrompt((current) => restoreFailedChatDraft(current, outgoingMessage))
          setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
        }
      } finally {
        if (isConversationCurrent()) {
          setLoading(false)
        }
      }
      return
    }
    if (getReminderParseFeedback(parsedReminder.reason, language)) {
      setReminderDraftError(parsedReminder.reason)
      promptInputRef.current?.focus()
      return
    }

    setPrompt('')
    setLoading(true)
    setStatusText(t(language, 'waitingResponse'))
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])
    const messageRequestContext = {
      ...getCurrentMainPanelAccountContext(),
      epoch: accountRequestEpochRef.current,
      session: activeSessionSnapshotRef.current,
    }
    const chatRequest = { sessionId: activeSessionId, context: messageRequestContext }
    if (chatRequest.sessionId !== null) {
      conversationRef.current.pending.set(chatRequest.sessionId, chatRequest)
    }
    const isReplyConversationVisible = () => (
      isMainPanelAccountRequestCurrent(messageRequestContext)
      && !conversationRef.current.selecting
      && chatRequest.sessionId !== null
      && conversationRef.current.sessionId === chatRequest.sessionId
      && conversationRef.current.pending.get(chatRequest.sessionId) === chatRequest
    )

    let messageDelivered = false
    try {
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: activeSessionId ?? undefined,
        use_rag: useRag,
        pet_type: currentPetType,
        compact_response: false,
      }, messageRequestContext)
      messageDelivered = true
      if (!isMainPanelAccountRequestCurrent(messageRequestContext)) {
        return
      }
      const nextSessionId = response.session_id
      chatRequest.sessionId = nextSessionId
      conversationRef.current.pending.set(nextSessionId, chatRequest)
      conversationRef.current.revision += 1
      void loadPetRelationship(currentPetType)
      void loadPetDailySummary(currentPetType)
      if (isConversationCurrent()) {
        updateActiveSessionId(nextSessionId)
        setMessages((current) => [...current, { role: 'assistant', content: response.content }])
        setStatusText(t(language, 'latestResponseReceived'))
      } else if (isReplyConversationVisible()) {
        // The selected history can already contain this exchange, or have been
        // read before its user message was saved. Preserve the known reply even
        // if the optional session-list refresh below fails.
        setMessages((current) => {
          const last = current.at(-1)
          const previous = current.at(-2)
          if (last?.role === 'assistant' && last.content === response.content
            && previous?.role === 'user' && previous.content === outgoingMessage) return current
          const withQuestion = last?.role === 'user' && last.content === outgoingMessage
            ? current
            : [...current, { role: 'user', content: outgoingMessage }]
          return [...withQuestion, { role: 'assistant', content: response.content }]
        })
        setStatusText(t(language, 'latestResponseReceived'))
      }
      const sessionListRequest = sessionListGateRef.current.begin(messageRequestContext)
      const shouldReadConversation = isConversationCurrent() || isReplyConversationVisible()
      const [listResult, detailResult] = await Promise.allSettled([
        desktopApi.getSessions(messageRequestContext),
        shouldReadConversation
          ? desktopApi.getSession(nextSessionId, messageRequestContext)
          : Promise.resolve(null),
      ])
      if (!isMainPanelAccountRequestCurrent(messageRequestContext)) {
        return
      }
      if (listResult.status === 'fulfilled') {
        commitAccountOperation(sessionListGateRef.current, sessionListRequest, getCurrentMainPanelAccountContext(), () => {
          setSessions(listResult.value)
        })
      }
      if (!isConversationCurrent() && !isReplyConversationVisible()) return
      const currentSession = detailResult.status === 'fulfilled' ? detailResult.value : null
      if (currentSession?.id === nextSessionId && Array.isArray(currentSession.messages)) {
        setMessages(currentSession.messages || [])
      }
      // Revisited history receives the completed exchange, while the original
      // send alone owns its transient status and knowledge-source presentation.
      if (!isConversationCurrent()) return
      if (useRag) {
        const nextSources = response.sources || []
        setKnowledgeSources(nextSources)
        if (nextSources.length > 0) {
          setKnowledgeStatusText(t(language, 'knowledgeHitHint', { count: nextSources.length }))
          setStatusText(t(language, 'latestResponseReceived'))
        } else {
          setKnowledgeStatusText(t(language, 'knowledgeMissHint'))
          setStatusText(t(language, 'knowledgeMissHint'))
        }
      } else {
        setKnowledgeStatusText('')
        setKnowledgeSources([])
        setStatusText(t(language, 'latestResponseReceived'))
      }
    } catch (error) {
      if ((isConversationCurrent() || isReplyConversationVisible()) && !messageDelivered) {
        setPrompt((current) => restoreFailedChatDraft(current, outgoingMessage))
        setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
      }
    } finally {
      if (!messageDelivered && isMainPanelAccountRequestCurrent(messageRequestContext)) {
        conversationRef.current.revision += 1
      }
      const visible = isReplyConversationVisible()
      if (conversationRef.current.pending.get(chatRequest.sessionId) === chatRequest) {
        conversationRef.current.pending.delete(chatRequest.sessionId)
      }
      if (isConversationCurrent() || visible) {
        setLoading(false)
      }
    }
  }

  const handleCreateOnboardingReminder = async () => {
    if (petOnboardingBusy || currentPetType !== 'pig') {
      return
    }
    setPetOnboardingBusy(true)
    setPetOnboardingError('')
    const expectedContextKey = petOnboardingContextKeyRef.current
    const onboardingRequestContext = {
      ...getCurrentMainPanelAccountContext(),
      relationshipId: petOnboardingContextRef.current.relationshipId,
      epoch: accountRequestEpochRef.current,
    }
    try {
      const reminder = await createReminder(
        createPetOnboardingSampleReminderPayload(language),
        onboardingRequestContext,
      )
      if (
        !isMainPanelAccountRequestCurrent(onboardingRequestContext)
        ||
        expectedContextKey !== petOnboardingContextKeyRef.current
        || Number(reminder.user_id) !== Number(petOnboardingContextRef.current.userId)
        || petOnboardingContextRef.current.petType !== 'pig'
      ) {
        throw new Error('onboarding_context_changed')
      }
      window.dispatchEvent(new Event('detachym:reminders-changed'))
      const result = await window.desktopBridge?.recordPetOnboardingObservation?.(
        'pig',
        PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
        { reminderId: reminder.id },
        onboardingRequestContext,
      )
      if (!isMainPanelAccountRequestCurrent(onboardingRequestContext)) {
        return
      }
      const nextState = applyPetOnboardingResponse(result, expectedContextKey)
      if (
        result === undefined
        || result?.ok === false
        || !isPetOnboardingReminderMatch(nextState?.reminder_id, reminder.id)
      ) {
        throw new Error(
          language === 'zh-CN'
            ? '提醒已经创建，但引导状态没有同步；请不要重复创建。'
            : 'The reminder was created, but the guide did not sync. Please do not create it again.',
        )
      }
      const copy = getPetReminderCopy('pig').createdReminder(
        reminder.title,
        new Date(reminder.remind_at).toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        reminder.email_enabled,
        '',
      )
      await window.desktopBridge?.notifyPetReminderEvent?.({
        type: 'created',
        petType: 'pig',
        title: reminder.title,
        message: copy,
        reminderId: reminder.id,
      }, onboardingRequestContext)
      if (
        !isMainPanelAccountRequestCurrent(onboardingRequestContext)
        || expectedContextKey !== petOnboardingContextKeyRef.current
      ) {
        return
      }
      void getPetRelationship('pig', onboardingRequestContext).then(async (nextRelationship) => {
        if (
          isMainPanelAccountRequestCurrent(onboardingRequestContext)
          && expectedContextKey === petOnboardingContextKeyRef.current
          && Number(nextRelationship?.user_id) === Number(petOnboardingContextRef.current.userId)
        ) {
          setPetRelationship(nextRelationship)
          await window.desktopBridge?.cachePetRelationship?.(nextRelationship, onboardingRequestContext)
        }
      }).catch((error) => {
        void logDesktopDebug({
          event: 'main-panel-onboarding-relationship-refresh-failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      })
      void loadPetDailySummary('pig')
      setStatusText(copy)
    } catch (error) {
      if (
        isMainPanelAccountRequestCurrent(onboardingRequestContext)
        && expectedContextKey === petOnboardingContextKeyRef.current
      ) {
        setPetOnboardingError(
          formatError(
            error,
            language === 'zh-CN'
              ? '提醒没有创建成功，请稍后再试。'
              : 'The reminder was not created. Try again later.',
          ),
        )
      }
    } finally {
      if (
        isMainPanelAccountRequestCurrent(onboardingRequestContext)
        && expectedContextKey === petOnboardingContextKeyRef.current
      ) {
        setPetOnboardingBusy(false)
      }
    }
  }

  const handleSnoozePetOnboarding = async () => {
    if (petOnboardingBusy) {
      return
    }
    setPetOnboardingBusy(true)
    setPetOnboardingError('')
    const expectedContextKey = petOnboardingContextKeyRef.current
    try {
      const result = await window.desktopBridge?.snoozePetOnboarding?.(
        'pig',
        getExpectedOnboardingAccountContext(),
      )
      if (result === undefined || result?.ok === false) {
        if (result !== undefined) {
          applyPetOnboardingResponse(result, expectedContextKey)
        }
        throw new Error(result?.reason || 'onboarding_snooze_rejected')
      }
      applyPetOnboardingResponse(result, expectedContextKey)
    } catch (error) {
      if (expectedContextKey === petOnboardingContextKeyRef.current) {
        setPetOnboardingError(formatError(
          error,
          language === 'zh-CN' ? '暂时隐藏失败，请稍后再试。' : 'Could not hide this for now. Try again later.',
        ))
      }
    } finally {
      if (expectedContextKey === petOnboardingContextKeyRef.current) {
        setPetOnboardingBusy(false)
      }
    }
  }

  const handleDismissPetOnboarding = async () => {
    if (petOnboardingBusy) {
      return
    }
    setPetOnboardingBusy(true)
    setPetOnboardingError('')
    const expectedContextKey = petOnboardingContextKeyRef.current
    try {
      const result = await window.desktopBridge?.dismissPetOnboarding?.(
        'pig',
        getExpectedOnboardingAccountContext(),
      )
      if (result === undefined || result?.ok === false) {
        if (result !== undefined) {
          applyPetOnboardingResponse(result, expectedContextKey)
        }
        throw new Error(result?.reason || 'onboarding_dismiss_rejected')
      }
      applyPetOnboardingResponse(result, expectedContextKey)
    } catch (error) {
      if (expectedContextKey === petOnboardingContextKeyRef.current) {
        setPetOnboardingError(formatError(
          error,
          language === 'zh-CN' ? '关闭提示失败，请稍后再试。' : 'Could not dismiss this. Try again later.',
        ))
      }
    } finally {
      if (expectedContextKey === petOnboardingContextKeyRef.current) {
        setPetOnboardingBusy(false)
      }
    }
  }

  const handlePromptKeyDown = (event) => {
    if (shouldSubmitChatInput(event)) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleSelectSession = async (sessionId) => {
    // Capture the click order before IPC: slower capability capture must not win.
    const requestContext = knowledgeSelectGateRef.current.begin(getCurrentMainPanelAccountContext())
    conversationRef.current.selecting = true
    setLoading(false)
    setSelectingSession(true)
    try {
      const operationContext = await captureApiOperationContext(
        requestContext,
        'account',
      )
      let session
      let revision
      do {
        revision = conversationRef.current.revision
        session = await desktopApi.getSession(sessionId, operationContext)
        await assertApiOperationContextCurrent(operationContext)
        if (!knowledgeSelectGateRef.current.isCurrent(requestContext, getCurrentMainPanelAccountContext())) return
        // A reply may commit while this history read is in flight. Re-read it
        // before showing the selected conversation so its answer is not lost.
      } while (revision !== conversationRef.current.revision)
      commitAccountOperation(
        knowledgeSelectGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => {
          updateActiveSessionId(session.id)
          setMessages(session.messages || [])
          setStatusText('')
          setKnowledgeStatusText('')
          setKnowledgeSources([])
        },
      )
    } catch (error) {
      commitAccountOperation(
        knowledgeSelectGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => setStatusText(formatError(error, t(language, 'unableToLoadSession'))),
      )
    } finally {
      commitAccountOperation(
        knowledgeSelectGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => {
          conversationRef.current.selecting = false
          setSelectingSession(false)
          const pendingChat = conversationRef.current.pending.get(conversationRef.current.sessionId)
          setLoading(Boolean(pendingChat && isMainPanelAccountRequestCurrent(pendingChat.context)))
        },
      )
    }
  }

  const handleNewChat = () => {
    knowledgeSelectGateRef.current.invalidate()
    conversationRef.current.selecting = false
    setSelectingSession(false)
    setLoading(false)
    updateActiveSessionId(null)
    setMessages([])
    setPrompt('')
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setStatusText('')
    setNewChatVersion((current) => current + 1)
    intentConsumerRef.current.cancel()
    setTab('chat')
  }

  const handleUpload = async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file || knowledgeMutationRef.current) return
    const initialContext = getCurrentMainPanelAccountContext()
    const requestContext = knowledgeUploadGateRef.current.begin({
      ...initialContext, local: createLocalOperationContext(initialContext, 'account'),
    })
    knowledgeMutationRef.current = requestContext
    setKnowledgeBusy(true)
    setStatusText(language === 'zh-CN' ? '正在上传并整理文档…' : 'Uploading and indexing your document…')
    let operationContext = null
    let uploadError = null
    const current = () => knowledgeMutationRef.current === requestContext
      && knowledgeUploadGateRef.current.isCurrent(requestContext, getCurrentMainPanelAccountContext())
    try {
      operationContext = await captureApiOperationContext(requestContext, 'account')
      if (!current()) return
      await desktopApi.uploadDocument(file, operationContext)
      await assertApiOperationContextCurrent(operationContext)
    } catch (error) {
      uploadError = error
    } finally {
      // The backend keeps failed uploads as removable documents. Refresh after
      // either outcome so a failed file cannot silently consume the quota.
      if (current() && operationContext) {
        try {
          const nextDocuments = await desktopApi.getDocuments(operationContext)
          await assertApiOperationContextCurrent(operationContext)
          if (current()) setDocuments(nextDocuments)
        } catch (refreshError) {
          if (!uploadError) uploadError = refreshError
        }
      }
      if (current()) setStatusText(uploadError
        ? formatError(uploadError, t(language, 'uploadFailed'))
        : t(language, 'documentUploadedIndexed'))
      if (knowledgeMutationRef.current === requestContext) {
        knowledgeMutationRef.current = null
        setKnowledgeBusy(false)
        input.value = ''
      }
    }
  }

  const handleDeleteDocument = async (documentId) => {
    if (knowledgeMutationRef.current) return
    const initialContext = getCurrentMainPanelAccountContext()
    const requestContext = knowledgeDeleteGateRef.current.begin({
      ...initialContext, local: createLocalOperationContext(initialContext, 'account'),
    })
    knowledgeMutationRef.current = requestContext
    setKnowledgeBusy(true)
    try {
      const operationContext = await captureApiOperationContext(
        requestContext,
        'account',
      )
      if (knowledgeMutationRef.current !== requestContext
        || !knowledgeDeleteGateRef.current.isCurrent(requestContext, getCurrentMainPanelAccountContext())) return
      await desktopApi.deleteDocument(documentId, operationContext)
      await assertApiOperationContextCurrent(operationContext)
      commitAccountOperation(
        knowledgeDeleteGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => {
          setDocuments((current) => current.filter((item) => item.id !== documentId))
          setStatusText(t(language, 'documentDeleted'))
        },
      )
    } catch (error) {
      commitAccountOperation(
        knowledgeDeleteGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => setStatusText(formatError(error, t(language, 'deleteFailed'))),
      )
    } finally {
      if (knowledgeMutationRef.current === requestContext) {
        knowledgeMutationRef.current = null
        setKnowledgeBusy(false)
      }
    }
  }

  const handleRefreshDocuments = async () => {
    if (knowledgeMutationRef.current) return
    const initialContext = getCurrentMainPanelAccountContext()
    const requestContext = knowledgeUploadGateRef.current.begin({
      ...initialContext, local: createLocalOperationContext(initialContext, 'account'),
    })
    knowledgeMutationRef.current = requestContext
    setKnowledgeBusy(true)
    try {
      const operationContext = await captureApiOperationContext(requestContext, 'account')
      if (knowledgeMutationRef.current !== requestContext) return
      const nextDocuments = await desktopApi.getDocuments(operationContext)
      await assertApiOperationContextCurrent(operationContext)
      commitAccountOperation(knowledgeUploadGateRef.current, requestContext, getCurrentMainPanelAccountContext(), () => {
        setDocuments(nextDocuments)
        setStatusText(language === 'zh-CN' ? '文档列表已更新。' : 'Document list updated.')
      })
    } catch (error) {
      commitAccountOperation(knowledgeUploadGateRef.current, requestContext, getCurrentMainPanelAccountContext(), () => {
        setStatusText(formatError(error, language === 'zh-CN' ? '更新文档列表失败，请重试。' : 'Unable to refresh documents. Try again.'))
      })
    } finally {
      if (knowledgeMutationRef.current === requestContext) {
        knowledgeMutationRef.current = null
        setKnowledgeBusy(false)
      }
    }
  }

  const handlePetSelect = async (nextPetType) => {
    if (!user || savingPet || nextPetType === currentPetType) {
      return
    }

    setSavingPet(true)
    const initiatingUserId = user.id
    const initiatingContext = {
      ...getCurrentMainPanelAccountContext(),
      epoch: accountRequestEpochRef.current,
    }
    const isInitiatingSessionCurrent = () => (
      activeUserIdRef.current === initiatingUserId
      && accountRequestEpochRef.current === initiatingContext.epoch
      && isSessionSnapshotCurrent(
        initiatingContext.session,
        activeSessionSnapshotRef.current,
      )
    )
    let switchCommitted = false
    try {
      const summary = await getPendingReminderSummary(currentPetType, initiatingContext)
      if (!isMainPanelAccountRequestCurrent(initiatingContext)) {
        return
      }
      if (summary.pending_count > 0) {
        const confirmed = window.confirm(
          language === 'zh-CN'
            ? `${currentPetLabel} 还有 ${summary.pending_count} 个待提醒事项，切换后不会提醒。确定切换吗？`
            : `${currentPetLabel} has ${summary.pending_count} pending reminders. They will not trigger after switching. Continue?`,
        )
        if (!confirmed) {
          return
        }
        if (!isMainPanelAccountRequestCurrent(initiatingContext)) {
          return
        }
      }
      const startedAt = Date.now()
      await logDesktopDebug({
        event: 'main-panel-switch-start',
        fromPetType: currentPetType,
        toPetType: nextPetType,
      })
      const nextPreferences = await withTimeout(
        desktopApi.updatePreferences({
          pet_type: nextPetType,
          quick_chat_enabled: user?.preferences?.quick_chat_enabled ?? true,
          bubble_frequency: user?.preferences?.bubble_frequency ?? 120,
        }, initiatingContext),
        12000,
        'update_preferences_timeout',
      )
      if (!isMainPanelAccountRequestCurrent(initiatingContext)) {
        return
      }
      await logDesktopDebug({
        event: 'main-panel-switch-phase',
        phase: 'preferences-updated',
        totalElapsedMs: Date.now() - startedAt,
        targetPetType: nextPetType,
      })
      const switchedResult = await withTimeout(
        window.desktopBridge?.switchPetFromMainPanel?.({
          petType: nextPetType,
          preferences: nextPreferences,
          language,
          hasSession: true,
          expectedUserId: initiatingUserId,
          expectedSession: initiatingContext.session,
          expectedFromPet: initiatingContext.petType,
          expectedContext: initiatingContext.authoritative,
        }),
        5000,
        'desktop_switch_timeout',
      )
      await logDesktopDebug({
        event: 'main-panel-switch-phase',
        phase: 'desktop-ipc-returned',
        totalElapsedMs: Date.now() - startedAt,
        targetPetType: nextPetType,
        ok: Boolean(switchedResult?.ok),
      })
      if (!switchedResult?.ok) {
        throw new Error(switchedResult?.reason || t(language, 'messageDeliveryFailed'))
      }
      if (
        activeUserIdRef.current !== initiatingUserId
        || !isSessionSnapshotCurrent(
          initiatingContext.session,
          activeSessionSnapshotRef.current,
        )
      ) {
        throw new Error('account-context-changed')
      }
      switchCommitted = true
      accountRequestEpochRef.current += 1
      knowledgeSelectGateRef.current.invalidate()
      setSelectingSession(false)
      setLoading(false)
      activePetTypeRef.current = nextPetType
      const switchedCapability = switchedResult.authoritative
      if (
        !switchedCapability
        ||
        activeUserIdRef.current !== initiatingUserId
        || !isSessionSnapshotCurrent(
          initiatingContext.session,
          activeSessionSnapshotRef.current,
        )
      ) {
        throw new Error('account-context-changed')
      }
      activeAuthoritativeContextRef.current = switchedCapability
      setReadyRelationshipContext(null)
      setPetRelationship(null)
      setPetDailySummary(null)
      setUser((current) => (current ? { ...current, preferences: nextPreferences } : current))
      void loadPetRelationship(nextPetType).then((ready) => {
        if (ready && activePetTypeRef.current === nextPetType) void loadPetDailySummary(nextPetType)
      })
      await logDesktopDebug({
        event: 'main-panel-switch-success',
        petType: switchedResult?.state?.petType || nextPetType,
        totalElapsedMs: Date.now() - startedAt,
      })
      setStatusText(t(language, 'petPreferenceSaved'))
    } catch (error) {
      if (isInitiatingSessionCurrent()) {
        await logDesktopDebug({
          event: 'main-panel-switch-failed',
          reason: error instanceof Error ? error.message : String(error),
        })
        if (isInitiatingSessionCurrent()) {
          setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
        }
      }
    } finally {
      if (switchCommitted || isInitiatingSessionCurrent()) {
        setSavingPet(false)
      }
    }
  }

  const handleOutfitChange = async (slot, itemId) => {
    if (
      currentPetType !== 'pig'
      || !petRelationship
      || savingOutfit
    ) {
      return
    }

    setSavingOutfit(true)
    const initiatingOutfitContext = {
      ...getCurrentMainPanelAccountContext(),
      relationshipId: petRelationship.id,
      epoch: accountRequestEpochRef.current,
    }
    let outfitRequestContext = null
    try {
      outfitRequestContext = await captureApiOperationContext(
        initiatingOutfitContext,
        'relationship',
      )
      if (!isMainPanelAccountRequestCurrent(initiatingOutfitContext)) return
      let nextRelationship = await updatePetOutfit(
        outfitRequestContext.petType,
        slot,
        itemId,
        outfitRequestContext,
      )
      const postOutfitCapability = nextRelationship?.__operation_authoritative
      if (
        !isMainPanelAccountRequestCurrent(outfitRequestContext)
        || !postOutfitCapability
        || Number(nextRelationship?.id) !== Number(initiatingOutfitContext.relationshipId)
        || Number(nextRelationship?.user_id) !== Number(initiatingOutfitContext.userId)
        || nextRelationship?.pet_type !== initiatingOutfitContext.petType
      ) {
        return
      }
      outfitRequestContext = { ...outfitRequestContext, authoritative: postOutfitCapability }
      activeAuthoritativeContextRef.current = postOutfitCapability
      setPetRelationship(nextRelationship)

      try {
        const reward = await rewardPetRelationship(
          outfitRequestContext.petType,
          'dress_up',
          createRewardIdempotencyKey(outfitRequestContext.petType, 'dress_up'),
          outfitRequestContext,
        )
        if (!isMainPanelAccountRequestCurrent(outfitRequestContext)) {
          return
        }
        if (reward.relationship) {
          nextRelationship = reward.relationship
          setPetRelationship(nextRelationship)
          const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
            nextRelationship,
            outfitRequestContext,
          )
          if (!cacheResult?.ok || !isMainPanelAccountRequestCurrent(outfitRequestContext)) {
            return
          }
          outfitRequestContext = {
            ...outfitRequestContext,
            authoritative: cacheResult.authoritative,
          }
          activeAuthoritativeContextRef.current = cacheResult.authoritative
        }
        void loadPetDailySummary(outfitRequestContext.petType)
        setStatusText(
          language === 'zh-CN'
            ? reward.awarded_xp > 0
              ? `装扮已保存，亲密度 +${reward.awarded_xp}。`
              : '装扮已保存。'
            : reward.awarded_xp > 0
              ? `Outfit saved. Intimacy +${reward.awarded_xp}.`
              : 'Outfit saved.',
        )
      } catch (rewardError) {
        if (!isMainPanelAccountRequestCurrent(outfitRequestContext)) {
          return
        }
        setStatusText(language === 'zh-CN' ? '装扮已保存。' : 'Outfit saved.')
        await logDesktopDebug({
          event: 'main-panel-outfit-reward-failed',
          reason: rewardError instanceof Error ? rewardError.message : String(rewardError),
        })
      }
    } catch (error) {
      if (outfitRequestContext && isMainPanelAccountRequestCurrent(outfitRequestContext)) {
        setStatusText(
        formatError(
          error,
          language === 'zh-CN' ? '保存装扮失败。' : 'Failed to save outfit.',
        ),
        )
      }
    } finally {
      if (outfitRequestContext && isMainPanelAccountRequestCurrent(outfitRequestContext)) {
        setSavingOutfit(false)
      }
    }
  }

  const handleReminderCompleted = async (completedReminder, providedRequestContext = null) => {
    let completionRequestContext = providedRequestContext || {
      ...getCurrentMainPanelAccountContext(),
      epoch: accountRequestEpochRef.current,
    }
    if (!isMainPanelAccountRequestCurrent(completionRequestContext)) {
      return
    }
    const completionUserId = completionRequestContext.userId
    const completionPetType = completionRequestContext.petType
    const isOnboardingCompletion = completionPetType === 'pig'
      && petOnboardingContextRef.current.petType === 'pig'
      && Number(petOnboardingContextRef.current.userId) === Number(completionUserId)
      && Number(completedReminder?.user_id) === Number(completionUserId)
      && isPetOnboardingReminderMatch(completedReminder?.id, petOnboardingState?.reminder_id)
    let onboardingRecorded = false

    if (isOnboardingCompletion) {
      const expectedContextKey = petOnboardingContextKeyRef.current
      try {
        const result = await window.desktopBridge?.recordPetOnboardingObservation?.(
          'pig',
          PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED,
          { reminderId: completedReminder.id },
          completionRequestContext,
        )
        if (!isMainPanelAccountRequestCurrent(completionRequestContext)) {
          return
        }
        if (result === undefined || result?.ok === false) {
          if (result !== undefined) {
            applyPetOnboardingResponse(result, expectedContextKey)
          }
          throw new Error(result?.reason || 'onboarding_reminder_completion_rejected')
        }
        applyPetOnboardingResponse(result, expectedContextKey)
        onboardingRecorded = result !== undefined
      } catch (error) {
        if (!isMainPanelAccountRequestCurrent(completionRequestContext)) {
          return
        }
        await logDesktopDebug({
          event: 'main-panel-onboarding-reminder-completion-failed',
          reminderId: completedReminder.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      const nextRelationship = await getPetRelationship(
        completionPetType,
        completionRequestContext,
      )
      if (
        !isMainPanelAccountRequestCurrent(completionRequestContext)
        || petOnboardingContextRef.current.petType !== completionPetType
        || Number(petOnboardingContextRef.current.userId) !== Number(completionUserId)
        || Number(nextRelationship?.user_id) !== Number(completionUserId)
      ) {
        return
      }
      setPetRelationship(nextRelationship)
      const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
        nextRelationship,
        completionRequestContext,
      )
      if (!cacheResult?.ok || !cacheResult.authoritative) {
        return
      }
      completionRequestContext = {
        ...completionRequestContext,
        relationshipId: nextRelationship.id,
        authoritative: cacheResult.authoritative,
      }
      activeAuthoritativeContextRef.current = cacheResult.authoritative
      if (!isMainPanelAccountRequestCurrent(completionRequestContext)) return
      void loadPetDailySummary(completionPetType)
      setStatusText(
        onboardingRecorded
          ? language === 'zh-CN'
            ? '这次配合完成了。以后有需要，再叫我提醒你。'
            : 'We wrapped that up together. Ask me whenever you need another reminder.'
          : language === 'zh-CN'
            ? '提醒已完成，亲密度已更新。'
            : 'Reminder completed. Intimacy updated.',
      )
    } catch (error) {
      if (isMainPanelAccountRequestCurrent(completionRequestContext)) {
        setStatusText(
        formatError(
          error,
          onboardingRecorded
            ? language === 'zh-CN'
              ? '这次配合已经完成，但亲密度同步失败。'
              : 'We wrapped that up, but intimacy sync failed.'
            : language === 'zh-CN'
              ? '提醒已完成，但亲密度同步失败。'
              : 'Reminder completed, but intimacy sync failed.',
        ),
        )
      }
    }
  }

  const handleVoiceEnabledChange = async (enabled) => {
    const nextEnabled = Boolean(enabled)
    if (savingVoiceSettings || nextEnabled === voiceSettings.desktop_voice_enabled) {
      return
    }

    setSavingVoiceSettings(true)
    try {
      const nextSettings = await updateVoiceSettings({
        desktop_voice_enabled: nextEnabled,
      })
      setVoiceSettingsState(normalizeVoiceSettings(nextSettings))
      setStatusText(
        language === 'zh-CN'
          ? nextEnabled
            ? '桌宠语音已启用。'
            : '桌宠语音已关闭。'
          : nextEnabled
            ? 'Desktop voice enabled.'
            : 'Desktop voice disabled.',
      )
    } catch (error) {
      setStatusText(formatError(error, language === 'zh-CN' ? '更新桌宠语音失败。' : 'Failed to update desktop voice.'))
    } finally {
      setSavingVoiceSettings(false)
    }
  }

  const handleVoiceOutputModeChange = async (nextMode) => {
    if (savingVoiceSettings || nextMode === voiceSettings.desktop_voice_output_mode) {
      return
    }

    setSavingVoiceSettings(true)
    try {
      const nextSettings = await updateVoiceSettings({
        desktop_voice_output_mode: nextMode,
      })
      setVoiceSettingsState(normalizeVoiceSettings(nextSettings))
      setStatusText(
        language === 'zh-CN'
          ? `桌宠回复模式已切换为${getVoiceModeLabel(language, nextMode)}。`
          : `Desktop reply mode switched to ${getVoiceModeLabel(language, nextMode)}.`,
      )
    } catch (error) {
      setStatusText(formatError(error, language === 'zh-CN' ? '更新语音模式失败。' : 'Failed to update voice mode.'))
    } finally {
      setSavingVoiceSettings(false)
    }
  }

  const handleCompanionModeChange = async (nextMode) => {
    if (
      savingCompanionSettings ||
      nextMode === companionSettings.mode ||
      !Object.values(COMPANION_MODES).includes(nextMode)
    ) {
      return
    }

    setSavingCompanionSettings(true)
    try {
      const nextSettings = await updateCompanionSettings({ mode: nextMode })
      setCompanionSettingsState(normalizeCompanionSettings(nextSettings))
      setStatusText(
        language === 'zh-CN'
          ? `主动陪伴已切换为${getCompanionModeLabel(language, nextMode)}。`
          : `Proactive companion switched to ${getCompanionModeLabel(language, nextMode)}.`,
      )
    } catch (error) {
      setStatusText(
        formatError(
          error,
          language === 'zh-CN'
            ? '更新主动陪伴设置失败。'
            : 'Failed to update proactive companion settings.',
        ),
      )
    } finally {
      setSavingCompanionSettings(false)
    }
  }

  const handleLogout = async () => {
    knowledgeMutationRef.current = null
    setKnowledgeBusy(false)
    knowledgeSelectGateRef.current.invalidate()
    setPrompt('')
    setLoading(false)
    setSelectingSession(false)
    accountRequestEpochRef.current += 1
    activeSessionTokenRef.current = null
    activeSessionSnapshotRef.current = null
    activeAuthoritativeContextRef.current = null
    activeUserIdRef.current = null
    activePetTypeRef.current = 'cat'
    relationshipRequestRef.current += 1
    dailySummaryRequestRef.current += 1
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    conversationRef.current.pending.clear()
    conversationRef.current.selecting = false
    updateActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setPetRelationship(null)
    setReadyRelationshipContext(null)
    setPetRelationshipError(false)
    setPetDailySummary(null)
    setPetOnboardingState(null)
    await window.desktopBridge?.syncPetState?.({
      source: 'main-panel',
      hasSession: false,
      userId: null,
      petType: 'cat',
      preferences: {
        pet_type: 'cat',
        quick_chat_enabled: true,
        bubble_frequency: 120,
      },
      language,
    })
    await logDesktopDebug({ event: 'main-panel-logout' })
    setStatusText(t(language, 'signedOut'))
  }

  const handleServerSetup = async () => {
    knowledgeMutationRef.current = null
    setKnowledgeBusy(false)
    knowledgeSelectGateRef.current.invalidate()
    setPrompt('')
    setLoading(false)
    setSelectingSession(false)
    accountRequestEpochRef.current += 1
    activeSessionTokenRef.current = null
    activeSessionSnapshotRef.current = null
    activeAuthoritativeContextRef.current = null
    activeUserIdRef.current = null
    activePetTypeRef.current = 'cat'
    relationshipRequestRef.current += 1
    dailySummaryRequestRef.current += 1
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    conversationRef.current.pending.clear()
    conversationRef.current.selecting = false
    updateActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setPetRelationship(null)
    setReadyRelationshipContext(null)
    setPetRelationshipError(false)
    setPetDailySummary(null)
    setPetOnboardingState(null)
    await window.desktopBridge?.syncPetState?.({
      source: 'main-panel',
      hasSession: false,
      userId: null,
      petType: 'cat',
      preferences: {
        pet_type: 'cat',
        quick_chat_enabled: true,
        bubble_frequency: 120,
      },
      language,
    })
    await logDesktopDebug({ event: 'main-panel-change-server' })
    setStatusText(t(language, 'updateServerUrlHint'))
  }

  const handleMinimizeWindow = async () => {
    await window.desktopBridge?.minimizeMainPanel?.()
    await logDesktopDebug({ event: 'main-panel-minimize' })
  }

  const handleHideWindow = async () => {
    await window.desktopBridge?.hideMainPanel?.()
    await logDesktopDebug({ event: 'main-panel-hide' })
  }

  const handleOpenQuickChat = async () => {
    await openQuickChat()
    await logDesktopDebug({ event: 'main-panel-open-quick-chat' })
    setStatusText(language === 'zh-CN' ? '快捷聊天已打开。' : 'Quick chat opened.')
  }

  const handleOpenFocus = () => {
    intentConsumerRef.current.cancel()
    pendingFocusNavigationRef.current = true
    tabRef.current = 'chat'
    setTab('chat')
    setFocusNavigationVersion((value) => value + 1)
  }

  const handleRetryCompanionSync = async () => {
    if (petRelationshipLoading) return
    const requestContext = {
      ...getCurrentMainPanelAccountContext(),
      epoch: accountRequestEpochRef.current,
    }
    const ready = await loadPetRelationship(requestContext.petType)
    if (ready && isMainPanelAccountRequestCurrent(requestContext)) {
      void loadPetDailySummary(requestContext.petType)
    }
  }

  if (!initialized) {
    return (
      <div className="window-shell" style={{ display: 'grid', placeItems: 'center' }}>
        {t(language, 'startingDesktopClient')}
      </div>
    )
  }

  if (!authenticated) {
    return (
      <LoginView
        apiBaseUrl={apiBaseUrl}
        onApiBaseUrlChange={setApiBaseUrlState}
        onSaveApiBaseUrl={handleSaveApiBaseUrl}
        onLoggedIn={async (receipt) => {
          if (await loadDashboard(receipt)) setInitialized(true)
        }}
        statusText={statusText}
        language={language}
        onLanguageChange={updateLanguage}
      />
    )
  }

  return (
    <div className="window-shell main-panel-shell" data-e2e="main-dashboard">
      <div className="window-card window-card-main">
        <header className="main-product-header">
          <div className="main-header-top">
            <div className="main-brand">
              <img src={getPetVisual(currentPetType, 'happy').image} alt="" />
              <div>
                <div className="main-brand-label">Detachym · {currentPetLabel}</div>
                <h1>{language === 'zh-CN' ? '今天，也一起慢慢来' : 'A little company for your day'}</h1>
              </div>
            </div>
            <div className="main-header-utilities">
              <LanguageSelector language={language} onChange={updateLanguage} compact />
              <button type="button" className="main-header-icon" title={t(language, 'minimizeWindow')} aria-label={t(language, 'minimizeWindow')} onClick={handleMinimizeWindow}>
                <Minus size={17} aria-hidden="true" />
              </button>
              <button type="button" className="main-header-icon" title={t(language, 'hideWindow')} aria-label={t(language, 'hideWindow')} onClick={handleHideWindow}>
                <X size={17} aria-hidden="true" />
              </button>
              <button type="button" className="main-header-action" data-e2e="logout" onClick={handleLogout}>
                {t(language, 'signOut')}
              </button>
            </div>
          </div>
          <div className="main-header-bottom">
            <nav className="main-navigation" aria-label={language === 'zh-CN' ? '主面板导航' : 'Main panel navigation'}>
              <button
                type="button"
                className="main-nav-button"
                data-e2e="main-tab-chat"
                aria-pressed={effectiveTab === 'chat'}
                onClick={() => {
                  intentConsumerRef.current.cancel()
                  setTab('chat')
                }}
              >
                {t(language, 'chat')}
              </button>
              <button
                type="button"
                className="main-nav-button"
                aria-pressed={effectiveTab === 'knowledge'}
                data-e2e="main-tab-knowledge"
                onClick={() => {
                  intentConsumerRef.current.cancel()
                  setTab('knowledge')
                }}
              >
                {t(language, 'knowledgeBase')}
              </button>
            </nav>
            <div className="main-header-shortcuts">
              {currentPetType === 'pig' && (
                <button type="button" className="main-header-action main-focus-shortcut" data-e2e="open-focus" aria-controls="companion-focus" onClick={handleOpenFocus}>
                  <Sprout size={14} aria-hidden="true" />
                  {language === 'zh-CN' ? '陪我专注' : 'Focus together'}
                </button>
              )}
              <button type="button" className="main-header-action" onClick={handleShowPet}>
                {t(language, 'showPet')}
              </button>
              <button type="button" className="main-header-action" onClick={handleOpenQuickChat}>
                <MessageCircle size={14} aria-hidden="true" />
                {t(language, 'quickChat')}
              </button>
              <details className="main-more-settings" onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.currentTarget.open = false
                  event.currentTarget.querySelector('summary')?.focus()
                }
              }}>
                <summary><Settings2 size={14} aria-hidden="true" />{language === 'zh-CN' ? '更多设置' : 'More settings'}</summary>
                <div className="main-settings-popover">
                  <div className="main-settings-account">{t(language, 'welcomeUser', { username: user?.username ?? '' })}</div>
                  <p className="main-settings-server">{t(language, 'serverLabel', { server: apiBaseUrl })}</p>
                  <button type="button" className="main-header-action" onClick={(event) => {
                    event.currentTarget.closest('details').open = false
                    void handleResetPetPosition()
                  }}>{t(language, 'resetPetPosition')}</button>
                  <button type="button" className="main-header-action" onClick={handleServerSetup}>{t(language, 'changeServer')}</button>
                </div>
              </details>
            </div>
          </div>
          {statusText && <div role="status" className="main-header-status">{statusText}</div>}
        </header>

        {effectiveTab === 'chat' ? (
          <div className="main-chat-layout">
            <aside className="panel main-companion-sidebar">
              <PetPreferencePicker
                language={language}
                activePetType={currentPetType}
                onSelect={(nextPetType) => {
                  void handlePetSelect(nextPetType)
                }}
                saving={savingPet}
              />
              {(!petDataReady || petRelationshipError) && (
                <section className="main-companion-sync" aria-busy={petRelationshipLoading} aria-label={language === 'zh-CN' ? '桌宠同步' : 'Companion sync'}>
                  <p role="status">{petRelationshipError
                    ? (language === 'zh-CN' ? '暂时没能同步桌宠记录。你可以继续聊天，稍后再试。' : 'Your companion’s records could not sync. You can keep chatting and try again.')
                    : (language === 'zh-CN' ? '正在找回我们的相处记录…' : 'Finding our shared moments…')}</p>
                  {petRelationshipError && (
                    <button type="button" data-e2e="companion-sync-retry" onClick={() => { void handleRetryCompanionSync() }} disabled={petRelationshipLoading}>
                      {language === 'zh-CN' ? '重新同步' : 'Retry sync'}
                    </button>
                  )}
                </section>
              )}
              {petDataReady && <>
              <PetRelationshipSummary
                language={language}
                petType={currentPetType}
                relationship={petRelationship}
                loading={petRelationshipLoading}
                sectionRef={relationshipSummaryRef}
              />
              {petOnboardingScene && (
                <PetOnboardingCard
                  sectionRef={petOnboardingCardRef}
                  language={language}
                  scene={petOnboardingScene}
                  relationship={petRelationship}
                  busy={petOnboardingBusy}
                  error={petOnboardingError}
                  onCreateSampleReminder={() => {
                    void handleCreateOnboardingReminder()
                  }}
                  onSnooze={() => {
                    void handleSnoozePetOnboarding()
                  }}
                  onDismiss={() => {
                    void handleDismissPetOnboarding()
                  }}
                />
              )}
              <PetDailySummaryPanel
                language={language}
                petType={currentPetType}
                summary={petDailySummary}
                loading={petDailySummaryLoading}
              />
              <FocusSessionPanel
                key={`focus-${user?.id || 'anonymous'}:${currentPetType}:${activeSessionSnapshotRef.current?.generation ?? 'none'}:${accountRequestEpochRef.current}`}
                language={language}
                accountContext={{
                  ...getCurrentMainPanelAccountContext(),
                  server: apiBaseUrl,
                  epoch: accountRequestEpochRef.current,
                }}
              />
              <PetWeeklySummaryPanel
                key={`weekly-${user?.id || 'anonymous'}:${currentPetType}:${activeSessionSnapshotRef.current?.generation ?? 'none'}:${accountRequestEpochRef.current}`}
                language={language}
                petType={currentPetType}
                accountContext={{
                  ...getCurrentMainPanelAccountContext(),
                  epoch: accountRequestEpochRef.current,
                }}
              />
              <PetOutfitPanel
                language={language}
                petType={currentPetType}
                relationship={petRelationship}
                saving={savingOutfit}
                onChange={(slot, itemId) => {
                  void handleOutfitChange(slot, itemId)
                }}
              />
              <CompanionSettingsPanel
                language={language}
                petType={currentPetType}
                settings={companionSettings}
                state={companionState}
                saving={savingCompanionSettings}
                onModeChange={(nextMode) => {
                  void handleCompanionModeChange(nextMode)
                }}
              />
              <PendingReminderPanel
                key={`${user?.id || 'anonymous'}:${currentPetType}:${activeSessionSnapshotRef.current?.generation ?? 'none'}`}
                language={language}
                petType={currentPetType}
                accountContext={{
                  ...getCurrentMainPanelAccountContext(),
                  relationshipId: petRelationship?.id ?? null,
                  epoch: accountRequestEpochRef.current,
                }}
                onCompleted={handleReminderCompleted}
                highlightReminderId={petOnboardingIsCurrent
                  ? petOnboardingState?.reminder_id
                  : null}
              />
              <RecurringReminderPanel
                key={`recurring-${user?.id || 'anonymous'}:${currentPetType}:${activeSessionSnapshotRef.current?.generation ?? 'none'}:${accountRequestEpochRef.current}`}
                language={language}
                petType={currentPetType}
                accountContext={{
                  ...getCurrentMainPanelAccountContext(),
                  relationshipId: petRelationship?.id ?? null,
                  epoch: accountRequestEpochRef.current,
                }}
              />
              </>}
              <VoiceSettingsPanel
                language={language}
                voiceSettings={voiceSettings}
                onEnabledChange={(enabled) => {
                  void handleVoiceEnabledChange(enabled)
                }}
                onOutputModeChange={(nextMode) => {
                  void handleVoiceOutputModeChange(nextMode)
                }}
                saving={savingVoiceSettings}
              />

              <div className="sidebar-section">
                <div className="sidebar-title">{t(language, 'sessions')}</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      data-e2e-session-id={session.id}
                      aria-pressed={session.id === activeSessionId}
                      className="button-secondary"
                      style={{
                        textAlign: 'left',
                        background: session.id === activeSessionId ? '#0f172a' : '#e2e8f0',
                        color: session.id === activeSessionId ? '#fff' : '#0f172a',
                      }}
                      onClick={() => handleSelectSession(session.id)}
                    >
                      {session.title}
                    </button>
                  ))}
                  {sessions.length === 0 && <div style={{ color: '#64748b', fontSize: 14 }}>{t(language, 'noSessionYet')}</div>}
                </div>
              </div>
            </aside>

            <section className="panel main-conversation-panel">
              <div className="toolbar main-conversation-heading">
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                    {t(language, 'currentSession')}
                  </div>
                  <div className="main-conversation-title">{activeSession?.title || (language === 'zh-CN' ? '聊点新的' : 'A fresh conversation')}</div>
                  <div style={{ marginTop: 8, fontSize: 13, color: '#64748b' }}>
                    {t(language, 'enterToSendHint')}
                  </div>
                </div>
                <button type="button" className="main-new-chat" data-e2e="new-chat" onClick={handleNewChat}>
                  <Plus size={15} aria-hidden="true" />{language === 'zh-CN' ? '新对话' : 'New chat'}
                </button>
              </div>
              <label className="main-knowledge-toggle">
                <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
                {t(language, 'enableKnowledgeBase')}
              </label>

              <ChatMessageStream
                messages={messages}
                conversation={`${user?.id}:${activeSessionId || 'new'}:${newChatVersion}`}
                emptyMessage={t(language, 'desktopPanelIntro', { pet: currentPetLabel })}
                language={language}
                busy={loading || selectingSession}
                showStarters={!activeSessionId && !prompt.trim() && !loading && !selectingSession}
                onChooseStarter={(message) => {
                  if (loading || selectingSession || activeSessionId || prompt.trim()) return
                  setPrompt(message)
                  promptInputRef.current?.focus()
                }}
              />

              {(knowledgeStatusText || knowledgeSources.length > 0) && (
                <div className="knowledge-feedback">
                  <div className="knowledge-feedback-title">{t(language, 'knowledgeBase')}</div>
                  {knowledgeStatusText && <div className="knowledge-feedback-copy">{knowledgeStatusText}</div>}
                  {knowledgeSources.length > 0 && (
                    <div className="knowledge-source-list">
                      {knowledgeSources.map((source) => (
                        <div key={`${source.document_id}-${source.filename}`} className="knowledge-source-item">
                          <div className="knowledge-source-name">{source.filename}</div>
                          <div className="knowledge-source-snippet">{source.snippet}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
                <textarea
                  className="textarea"
                  data-e2e="main-chat-input"
                  ref={promptInputRef}
                  rows={5}
                  value={prompt}
                  aria-label={t(language, 'typeMessagePlaceholder', { pet: currentPetLabel })}
                  aria-invalid={Boolean(reminderDraftFeedback)}
                  aria-describedby={reminderDraftFeedback ? 'main-reminder-draft-feedback' : undefined}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={handlePromptKeyDown}
                  placeholder={t(language, 'typeMessagePlaceholder', { pet: currentPetLabel })}
                />
                {reminderDraftFeedback && <div id="main-reminder-draft-feedback" className="reminder-draft-feedback" role="alert" data-e2e="main-reminder-draft-error">{reminderDraftFeedback}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="button-primary" data-e2e="main-chat-send" onClick={handleSend} disabled={loading || selectingSession || !prompt.trim()}>
                    {loading ? t(language, 'sending') : t(language, 'sendMessage')}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : (
          <div className="panel main-knowledge-panel" aria-busy={knowledgeBusy}>
            <div className="toolbar">
              <div>
                <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                  {t(language, 'knowledgeBase')}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{t(language, 'manageDocuments')}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button type="button" className="button-secondary" data-e2e="knowledge-refresh" disabled={knowledgeBusy} onClick={handleRefreshDocuments}>
                  {language === 'zh-CN' ? '刷新列表' : 'Refresh list'}
                </button>
                <button type="button" className="button-secondary" disabled={knowledgeBusy} onClick={() => knowledgeFileRef.current?.click()}>
                  {t(language, 'uploadDocument')}
                </button>
                <input ref={knowledgeFileRef} type="file" data-e2e="knowledge-upload" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleUpload} disabled={knowledgeBusy} />
              </div>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {documents.length === 0 ? (
                <div style={{ fontSize: 14, color: '#64748b' }}>{t(language, 'noDocumentYet')}</div>
              ) : (
                documents.map((document) => (
                  <div
                    key={document.id}
                    data-e2e-document-id={document.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: 12,
                      alignItems: 'center',
                      border: '1px solid #cbd5e1',
                      borderRadius: 18,
                      padding: 14,
                    }}
                  >
                    <div style={{ overflowWrap: 'anywhere' }}>
                      <div style={{ fontWeight: 700 }}>{document.filename}</div>
                      {document.status === 'failed' && <div role="status" style={{ marginTop: 6, color: '#be123c', fontSize: 13 }}>
                        {language === 'zh-CN' ? '索引失败，可删除后检查文件并重新上传。' : 'Indexing failed. Delete this file, check its contents, then upload again.'}
                      </div>}
                      <div style={{ marginTop: 6, fontSize: 13, color: '#64748b' }}>
                        {document.status === 'indexed'
                          ? (language === 'zh-CN' ? '已可用于问答' : 'Ready for questions')
                          : document.status === 'failed'
                            ? (language === 'zh-CN' ? '整理失败' : 'Indexing failed')
                            : (language === 'zh-CN' ? '正在整理' : 'Indexing')}
                        {' · '}{Math.max(1, Math.round((document.file_size || 0) / 1024))} KB
                      </div>
                    </div>
                    <button type="button" className="button-secondary" data-e2e-delete-document={document.id} aria-label={`${t(language, 'delete')} ${document.filename}`} disabled={knowledgeBusy} onClick={() => handleDeleteDocument(document.id)}>
                      {t(language, 'delete')}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<MainPanelApp />)
