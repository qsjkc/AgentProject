import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { PetOnboardingCard } from './components/PetOnboardingCard'
import { PendingReminderPanel } from './components/PendingReminderPanel'
import { RecurringReminderPanel } from './components/RecurringReminderPanel'
import { PetOutfitPanel } from './components/PetOutfitPanel'
import {
  checkApiConnection,
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
import { getPetReminderCopy } from './shared/pet-personality'
import {
  createRewardIdempotencyKey,
  getRelationshipStageLabel,
  normalizePetRelationship,
} from './shared/pet-relationship'
import {
  commitAccountOperation,
  createAccountOperationGate,
  adoptRelationshipCapability,
  createMainPanelRelationshipNullReset,
  isPetAccountOperationCurrent,
  isSessionSnapshotCurrent,
} from './shared/pet-account-context'
import { createMainPanelIntentConsumerController } from './shared/main-panel-intent-controller'
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

function LanguageSelector({ language, onChange }) {
  return (
    <label style={{ display: 'grid', gap: 6, minWidth: 164 }}>
      <span style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
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

  const handleTestConnection = async () => {
    setTesting(true)
    setError('')
    try {
      await onSaveApiBaseUrl()
    } catch (connectionError) {
      setError(formatError(connectionError, t(language, 'unableToReachService')))
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      await onSaveApiBaseUrl()
      await login(username, password)
      await window.desktopBridge?.showNotification?.({
        title: t(language, 'appName'),
        body: t(language, 'desktopClientLoginSucceeded'),
      })
      await onLoggedIn()
    } catch (loginError) {
      setError(formatError(loginError, t(language, 'loginFailed')))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="window-shell" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="panel" style={{ width: 560, padding: 28 }}>
        <div className="toolbar" style={{ alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#64748b' }}>
              {t(language, 'desktopAccess')}
            </div>
            <div style={{ marginTop: 16, fontSize: 36, fontWeight: 700 }}>{t(language, 'desktopTitle')}</div>
          </div>
          <LanguageSelector language={language} onChange={onLanguageChange} />
        </div>
        <p style={{ marginTop: 12, color: '#475569', lineHeight: 1.8 }}>{t(language, 'desktopIntro')}</p>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14, marginTop: 24 }}>
          <input
            className="input"
            data-e2e="login-api-base-url"
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            placeholder={t(language, 'serverUrlPlaceholder')}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="button-secondary" type="button" onClick={handleTestConnection} disabled={testing || loading}>
              {testing ? t(language, 'testing') : t(language, 'testConnection')}
            </button>
          </div>
          <input
            className="input"
            data-e2e="login-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t(language, 'usernameOrEmail')}
          />
          <input
            className="input"
            data-e2e="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t(language, 'password')}
          />
          {(error || statusText) && <div style={{ color: error ? '#be123c' : '#475569', fontSize: 14 }}>{error || statusText}</div>}
          <button className="button-primary" data-e2e="login-submit" type="submit" disabled={loading}>
            {loading ? t(language, 'signingIn') : t(language, 'signIn')}
          </button>
        </form>
      </div>
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
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [useRag, setUseRag] = useState(true)
  const [documents, setDocuments] = useState([])
  const [statusText, setStatusText] = useState('')
  const [knowledgeStatusText, setKnowledgeStatusText] = useState('')
  const [knowledgeSources, setKnowledgeSources] = useState([])
  const [loading, setLoading] = useState(false)
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
  const [petDailySummary, setPetDailySummary] = useState(null)
  const [petDailySummaryLoading, setPetDailySummaryLoading] = useState(false)
  const [petOnboardingState, setPetOnboardingState] = useState(null)
  const [petOnboardingBusy, setPetOnboardingBusy] = useState(false)
  const [petOnboardingError, setPetOnboardingError] = useState('')
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible')
  const [onboardingClock, setOnboardingClock] = useState(() => Date.now())
  const [intentOverride, setIntentOverride] = useState(null)
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
  const knowledgeUploadGateRef = useRef(null)
  const knowledgeDeleteGateRef = useRef(null)
  const companionLoadGateRef = useRef(null)
  if (!knowledgeSelectGateRef.current) knowledgeSelectGateRef.current = createAccountOperationGate()
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
      epoch: accountRequestEpochRef.current,
      session: activeSessionSnapshotRef.current,
    }
    setPetRelationshipLoading(true)

    let cachedRelationship = null
    try {
      cachedRelationship = normalizePetRelationship(
        await window.desktopBridge?.getCachedPetRelationship?.(petType, requestContext),
        petType,
      )
      if (
        cachedRelationship
        && relationshipRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
        && Number(cachedRelationship.user_id) === Number(requestContext.userId)
      ) {
        setPetRelationship(cachedRelationship)
      }

      const remoteRelationship = await getPetRelationship(petType, requestContext)
      if (
        relationshipRequestRef.current !== requestId
        || !isMainPanelAccountRequestCurrent(requestContext)
        || Number(remoteRelationship?.user_id) !== Number(requestContext.userId)
        || remoteRelationship?.pet_type !== requestContext.petType
      ) {
        return
      }
      setPetRelationship(remoteRelationship)
      const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
        remoteRelationship,
        requestContext,
      )
      if (!cacheResult?.ok || !isMainPanelAccountRequestCurrent(requestContext)) {
        return
      }
      if (
        !cacheResult.authoritative
        || Number(cacheResult.relationship?.id) !== Number(remoteRelationship.id)
        || Number(cacheResult.relationship?.user_id) !== Number(requestContext.userId)
      ) return
      activeAuthoritativeContextRef.current = cacheResult.authoritative
    } catch (error) {
      if (
        !cachedRelationship
        && relationshipRequestRef.current === requestId
        && isMainPanelAccountRequestCurrent(requestContext)
      ) {
        setPetRelationship(null)
      }
      await logDesktopDebug({
        event: 'main-panel-relationship-load-failed',
        petType,
        reason: error instanceof Error ? error.message : String(error),
      })
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

  const loadDashboard = async () => {
    const requestEpoch = accountRequestEpochRef.current + 1
    accountRequestEpochRef.current = requestEpoch
    const operationContext = await captureApiOperationContext({ epoch: requestEpoch }, 'account')
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
    setUser(me)
    setSessions(sessionList)
    setDocuments(documentList)
    if (sessionList.length > 0) {
      setActiveSessionId(sessionList[0].id)
      setMessages(sessionList[0].messages || [])
    } else {
      setActiveSessionId(null)
      setMessages([])
    }
    setAuthenticated(true)
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
      !synchronizedState?.ok
      || !synchronizedCapability
      ||
      accountRequestEpochRef.current !== requestEpoch
      || !isSessionSnapshotCurrent(operationContext.session, activeSessionSnapshotRef.current)
    ) {
      return false
    }
    activeAuthoritativeContextRef.current = synchronizedCapability
    void loadPetRelationship(me?.preferences?.pet_type || 'cat')
    void loadPetDailySummary(me?.preferences?.pet_type || 'cat')
    await logDesktopDebug({
      event: 'main-panel-load-dashboard',
      petType: me?.preferences?.pet_type || 'cat',
      sessionCount: sessionList.length,
    })
    return true
  }

  const handleSaveApiBaseUrl = async () => {
    const verifiedApiBaseUrl = await checkApiConnection(apiBaseUrl)
    await setApiBaseUrl(verifiedApiBaseUrl)
    setApiBaseUrlState(verifiedApiBaseUrl)
    setStatusText(t(language, 'serverConnectionVerified'))
    return verifiedApiBaseUrl
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
    // Register after dashboard hydration so a reload cannot discard the pending
    // intent while authentication/relationship state is still empty.
    if (
      !authenticated
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
  }, [authenticated, user?.id, currentPetType, petRelationship?.id, petRelationship?.user_id, petRelationship?.pet_type])

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
      !petOnboardingIsCurrent
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
        setActiveSessionId(null)
        setMessages([])
        setDocuments([])
        setLoading(false)
        setSavingPet(runtimeReset.savingPet)
        setSavingOutfit(runtimeReset.savingOutfit)
        setSavingCompanionSettings(runtimeReset.savingCompanionSettings)
        setPetRelationshipLoading(runtimeReset.petRelationshipLoading)
        setPetDailySummaryLoading(runtimeReset.petDailySummaryLoading)
        setPetOnboardingBusy(runtimeReset.petOnboardingBusy)
        setPetOnboardingError(runtimeReset.petOnboardingError)
        setCompanionState(DEFAULT_COMPANION_STATE)
        setPetRelationship(null)
        setPetDailySummary(null)
        setPetOnboardingState(null)
        return
      }
      void (async () => {
        const adopted = await adoptRelationshipCapability({
          payload,
          currentContext: getCurrentMainPanelAccountContext(),
          validateCapability: (capability, requiredScope, semantic) => (
            window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
          ),
        })
        if (!adopted) return
        const relationship = normalizePetRelationship(adopted.relationship, currentPetType)
        activeAuthoritativeContextRef.current = adopted.authoritative
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
    if (!prompt.trim() || loading) {
      return
    }

    const outgoingMessage = prompt.trim()
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
        if (
          !isMainPanelAccountRequestCurrent(reminderRequestContext)
          || Number(reminder.user_id) !== Number(reminderRequestContext.userId)
        ) {
          return
        }
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
        setMessages((current) => [
          ...current,
          { role: 'user', content: outgoingMessage },
          { role: 'assistant', content: copy },
        ])
        setStatusText(copy)
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
        if (isMainPanelAccountRequestCurrent(reminderRequestContext)) {
          setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
        }
      } finally {
        if (isMainPanelAccountRequestCurrent(reminderRequestContext)) {
          setLoading(false)
        }
      }
      return
    }
    if (parsedReminder.reason === 'missing_time') {
      const copy = getPetReminderCopy(currentPetType).parseFailed
      setPrompt('')
      setMessages((current) => [
        ...current,
        { role: 'user', content: outgoingMessage },
        { role: 'assistant', content: copy },
      ])
      setStatusText(copy)
      await window.desktopBridge?.notifyPetReminderEvent?.({
        type: 'parse_failed',
        petType: currentPetType,
        message: copy,
      }, getCurrentMainPanelAccountContext())
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

    try {
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: activeSessionId ?? undefined,
        use_rag: useRag,
        pet_type: currentPetType,
        compact_response: false,
      }, messageRequestContext)
      if (!isMainPanelAccountRequestCurrent(messageRequestContext)) {
        return
      }
      const nextSessionId = response.session_id
      void loadPetRelationship(currentPetType)
      void loadPetDailySummary(currentPetType)
      setActiveSessionId(nextSessionId)
      setMessages((current) => [...current, { role: 'assistant', content: response.content }])
      const nextSessions = await desktopApi.getSessions(messageRequestContext)
      if (!isMainPanelAccountRequestCurrent(messageRequestContext)) {
        return
      }
      setSessions(nextSessions)
      const currentSession = nextSessions.find((session) => session.id === nextSessionId)
      if (currentSession) {
        setMessages(currentSession.messages || [])
      }
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
      if (isMainPanelAccountRequestCurrent(messageRequestContext)) {
        setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
      }
    } finally {
      if (isMainPanelAccountRequestCurrent(messageRequestContext)) {
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleSelectSession = async (sessionId) => {
    let requestContext = null
    try {
      const operationContext = await captureApiOperationContext(
        getCurrentMainPanelAccountContext(),
        'account',
      )
      requestContext = knowledgeSelectGateRef.current.begin(operationContext)
      const session = await desktopApi.getSession(sessionId, operationContext)
      await assertApiOperationContextCurrent(operationContext)
      commitAccountOperation(
        knowledgeSelectGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => {
          setActiveSessionId(session.id)
          setMessages(session.messages || [])
          setKnowledgeStatusText('')
          setKnowledgeSources([])
        },
      )
    } catch (error) {
      if (!requestContext) return
      commitAccountOperation(
        knowledgeSelectGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => setStatusText(formatError(error, t(language, 'unableToLoadSession'))),
      )
    }
  }

  const handleUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    let requestContext = null
    try {
      const operationContext = await captureApiOperationContext(
        getCurrentMainPanelAccountContext(),
        'account',
      )
      requestContext = knowledgeUploadGateRef.current.begin(operationContext)
      await desktopApi.uploadDocument(file, operationContext)
      await assertApiOperationContextCurrent(operationContext)
      if (!knowledgeUploadGateRef.current.isCurrent(requestContext, getCurrentMainPanelAccountContext())) return
      const nextDocuments = await desktopApi.getDocuments(operationContext)
      await assertApiOperationContextCurrent(operationContext)
      commitAccountOperation(
        knowledgeUploadGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => {
          setDocuments(nextDocuments)
          setStatusText(t(language, 'documentUploadedIndexed'))
        },
      )
    } catch (error) {
      if (!requestContext) return
      commitAccountOperation(
        knowledgeUploadGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => setStatusText(formatError(error, t(language, 'uploadFailed'))),
      )
    } finally {
      if (!requestContext) {
        event.target.value = ''
        return
      }
      commitAccountOperation(
        knowledgeUploadGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => { event.target.value = '' },
      )
    }
  }

  const handleDeleteDocument = async (documentId) => {
    let requestContext = null
    try {
      const operationContext = await captureApiOperationContext(
        getCurrentMainPanelAccountContext(),
        'account',
      )
      requestContext = knowledgeDeleteGateRef.current.begin(operationContext)
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
      if (!requestContext) return
      commitAccountOperation(
        knowledgeDeleteGateRef.current,
        requestContext,
        getCurrentMainPanelAccountContext(),
        () => setStatusText(formatError(error, t(language, 'deleteFailed'))),
      )
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
      setUser((current) => (current ? { ...current, preferences: nextPreferences } : current))
      void loadPetRelationship(nextPetType)
      void loadPetDailySummary(nextPetType)
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
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setPetRelationship(null)
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
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setPetRelationship(null)
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
        onLoggedIn={async () => {
          await loadDashboard()
          setInitialized(true)
        }}
        statusText={statusText}
        language={language}
        onLanguageChange={updateLanguage}
      />
    )
  }

  return (
    <div className="window-shell" data-e2e="main-dashboard">
      <div className="window-card window-card-main" style={{ gap: 18 }}>
        <div className="panel" style={{ padding: 18 }}>
          <div className="toolbar" style={{ alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#64748b' }}>
                {t(language, 'desktopMainPanel')}
              </div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{t(language, 'welcomeUser', { username: user?.username ?? '' })}</div>
              <div style={{ marginTop: 8, fontSize: 13, color: '#64748b' }}>
                {t(language, 'serverLabel', { server: apiBaseUrl })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <LanguageSelector language={language} onChange={updateLanguage} />
              <button
                type="button"
                className="button-secondary"
                style={{ background: effectiveTab === 'chat' ? '#cbd5e1' : '#e2e8f0' }}
                onClick={() => {
                  intentConsumerRef.current.cancel()
                  setTab('chat')
                }}
              >
                {t(language, 'chat')}
              </button>
              <button
                type="button"
                className="button-secondary"
                style={{ background: effectiveTab === 'knowledge' ? '#cbd5e1' : '#e2e8f0' }}
                data-e2e="main-tab-knowledge"
                onClick={() => {
                  intentConsumerRef.current.cancel()
                  setTab('knowledge')
                }}
              >
                {t(language, 'knowledgeBase')}
              </button>
              <button type="button" className="button-secondary" onClick={handleShowPet}>
                {t(language, 'showPet')}
              </button>
              <button type="button" className="button-secondary" onClick={handleResetPetPosition}>
                {t(language, 'resetPetPosition')}
              </button>
              <button type="button" className="button-secondary" onClick={handleOpenQuickChat}>
                {language === 'zh-CN' ? '打开快捷聊天' : 'Open Quick Chat'}
              </button>
              <button type="button" className="button-secondary" onClick={handleServerSetup}>
                {t(language, 'changeServer')}
              </button>
              <button type="button" className="button-secondary" onClick={handleMinimizeWindow}>
                {t(language, 'minimizeWindow')}
              </button>
              <button type="button" className="button-secondary" onClick={handleHideWindow}>
                {t(language, 'hideWindow')}
              </button>
              <button type="button" className="button-primary" data-e2e="logout" onClick={handleLogout}>
                {t(language, 'signOut')}
              </button>
            </div>
          </div>
          {statusText && <div style={{ marginTop: 12, fontSize: 13, color: '#475569' }}>{statusText}</div>}
        </div>

        {effectiveTab === 'chat' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 18, flex: 1, minHeight: 0 }}>
            <aside className="panel" style={{ padding: 18, overflow: 'auto' }}>
              <PetPreferencePicker
                language={language}
                activePetType={currentPetType}
                onSelect={(nextPetType) => {
                  void handlePetSelect(nextPetType)
                }}
                saving={savingPet}
              />
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

            <section className="panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="toolbar" style={{ marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                    {t(language, 'currentSession')}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{activeSession?.title || t(language, 'newSession')}</div>
                  <div style={{ marginTop: 8, fontSize: 13, color: '#64748b' }}>
                    {t(language, 'enterToSendHint')}
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
                  {t(language, 'enableKnowledgeBase')}
                </label>
              </div>

              <div className="chat-stream" style={{ flex: 1, minHeight: 0 }}>
                {messages.length === 0 && (
                  <div className="message assistant">{t(language, 'desktopPanelIntro', { pet: currentPetLabel })}</div>
                )}
                {messages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={`message ${item.role}`}>
                    {item.content}
                  </div>
                ))}
              </div>

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
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={handlePromptKeyDown}
                  placeholder={t(language, 'typeMessagePlaceholder', { pet: currentPetLabel })}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="button-primary" onClick={handleSend} disabled={loading}>
                    {loading ? t(language, 'sending') : t(language, 'sendMessage')}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : (
          <div className="panel" style={{ padding: 18, display: 'grid', gap: 18 }}>
            <div className="toolbar">
              <div>
                <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                  {t(language, 'knowledgeBase')}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{t(language, 'manageDocuments')}</div>
              </div>
              <label className="button-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {t(language, 'uploadDocument')}
                <input type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleUpload} />
              </label>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {documents.length === 0 ? (
                <div style={{ fontSize: 14, color: '#64748b' }}>{t(language, 'noDocumentYet')}</div>
              ) : (
                documents.map((document) => (
                  <div
                    key={document.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 12,
                      alignItems: 'center',
                      border: '1px solid #cbd5e1',
                      borderRadius: 18,
                      padding: 14,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{document.filename}</div>
                      <div style={{ marginTop: 6, fontSize: 13, color: '#64748b' }}>
                        {t(language, 'documentMeta', {
                          status: document.status,
                          count: document.chunk_count,
                          size: Math.round((document.file_size || 0) / 1024),
                        })}
                      </div>
                    </div>
                    <button type="button" className="button-secondary" onClick={() => handleDeleteDocument(document.id)}>
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
