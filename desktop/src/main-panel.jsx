import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import {
  checkApiConnection,
  clearSessionToken,
  desktopApi,
  getApiBaseUrl,
  getLanguage,
  getSessionToken,
  getVoiceSettings,
  login,
  openQuickChat,
  setApiBaseUrl,
  setLanguage,
  updateVoiceSettings,
} from './shared/api'
import { normalizeLanguage, SUPPORTED_LANGUAGES, t } from './shared/i18n'
import { getPetReminderCopy } from './shared/pet-personality'
import { getPetVisual } from './shared/pets'
import { parseOneTimeReminder } from './shared/reminder-parser'
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
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t(language, 'usernameOrEmail')}
          />
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t(language, 'password')}
          />
          {(error || statusText) && <div style={{ color: error ? '#be123c' : '#475569', fontSize: 14 }}>{error || statusText}</div>}
          <button className="button-primary" type="submit" disabled={loading}>
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
  const [savingVoiceSettings, setSavingVoiceSettings] = useState(false)
  const [apiBaseUrl, setApiBaseUrlState] = useState('')
  const [language, setLanguageState] = useState('zh-CN')
  const [voiceSettings, setVoiceSettingsState] = useState(DEFAULT_VOICE_SETTINGS)

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )
  const currentPetType = user?.preferences?.pet_type ?? 'cat'
  const currentPetLabel = useMemo(() => t(language, getPetVisual(currentPetType, 'idle').labelKey), [currentPetType, language])

  const updateLanguage = async (nextLanguage) => {
    const savedLanguage = await setLanguage(nextLanguage)
    setLanguageState(normalizeLanguage(savedLanguage))
  }

  const loadDashboard = async () => {
    const [me, sessionList, documentList] = await Promise.all([
      desktopApi.me(),
      desktopApi.getSessions(),
      desktopApi.getDocuments(),
    ])

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
    await window.desktopBridge?.syncPetState?.({
      source: 'main-panel',
      hasSession: true,
      petType: me?.preferences?.pet_type || 'cat',
      preferences: me?.preferences || {},
      language,
    })
    await logDesktopDebug({
      event: 'main-panel-load-dashboard',
      petType: me?.preferences?.pet_type || 'cat',
      sessionCount: sessionList.length,
    })
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
        const savedVoiceSettings = normalizeVoiceSettings(await getVoiceSettings())

        if (active) {
          setApiBaseUrlState(savedApiBaseUrl || '')
          setLanguageState(normalizeLanguage(savedLanguage))
          setVoiceSettingsState(savedVoiceSettings)
        }

        if (!token || !savedApiBaseUrl) {
          return
        }

        await loadDashboard()
        await logDesktopDebug({
          event: 'main-panel-runtime-state-initial',
          runtimeState: await window.desktopBridge?.getRuntimeState?.(),
        })
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
    const unsubscribe = window.desktopBridge?.onVoiceSettingsChanged?.((payload) => {
      setVoiceSettingsState(normalizeVoiceSettings(payload))
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

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
    loading,
    useRag,
  ])

  const handleSend = async () => {
    if (!prompt.trim() || loading) {
      return
    }

    const outgoingMessage = prompt.trim()
    const parsedReminder = parseOneTimeReminder(outgoingMessage)
    if (parsedReminder.ok) {
      setPrompt('')
      setLoading(true)
      setStatusText(t(language, 'waitingResponse'))
      setKnowledgeStatusText('')
      setKnowledgeSources([])
      try {
        const reminder = await createReminder({
          pet_type: currentPetType,
          title: parsedReminder.title,
          source_text: parsedReminder.sourceText,
          remind_at: parsedReminder.remindAt.toISOString(),
        })
        const timeText = parsedReminder.remindAt.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        const copy = getPetReminderCopy(currentPetType).createdReminder(reminder.title, timeText)
        setMessages((current) => [
          ...current,
          { role: 'user', content: outgoingMessage },
          { role: 'assistant', content: copy },
        ])
        setStatusText(copy)
        await window.desktopBridge?.notifyPetReminderEvent?.({
          type: 'created',
          petType: currentPetType,
          title: reminder.title,
          message: copy,
        })
      } catch (error) {
        setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
      } finally {
        setLoading(false)
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
      })
      return
    }

    setPrompt('')
    setLoading(true)
    setStatusText(t(language, 'waitingResponse'))
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])

    try {
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: activeSessionId ?? undefined,
        use_rag: useRag,
        pet_type: currentPetType,
        compact_response: false,
      })
      const nextSessionId = response.session_id
      setActiveSessionId(nextSessionId)
      setMessages((current) => [...current, { role: 'assistant', content: response.content }])
      const nextSessions = await desktopApi.getSessions()
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
      setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
    } finally {
      setLoading(false)
    }
  }

  const handlePromptKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleSelectSession = async (sessionId) => {
    try {
      const session = await desktopApi.getSession(sessionId)
      setActiveSessionId(session.id)
      setMessages(session.messages || [])
      setKnowledgeStatusText('')
      setKnowledgeSources([])
    } catch (error) {
      setStatusText(formatError(error, t(language, 'unableToLoadSession')))
    }
  }

  const handleUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      await desktopApi.uploadDocument(file)
      setDocuments(await desktopApi.getDocuments())
      setStatusText(t(language, 'documentUploadedIndexed'))
    } catch (error) {
      setStatusText(formatError(error, t(language, 'uploadFailed')))
    } finally {
      event.target.value = ''
    }
  }

  const handleDeleteDocument = async (documentId) => {
    try {
      await desktopApi.deleteDocument(documentId)
      setDocuments((current) => current.filter((item) => item.id !== documentId))
      setStatusText(t(language, 'documentDeleted'))
    } catch (error) {
      setStatusText(formatError(error, t(language, 'deleteFailed')))
    }
  }

  const handlePetSelect = async (nextPetType) => {
    if (!user || savingPet || nextPetType === currentPetType) {
      return
    }

    setSavingPet(true)
    try {
      const summary = await getPendingReminderSummary(currentPetType)
      if (summary.pending_count > 0) {
        const confirmed = window.confirm(
          language === 'zh-CN'
            ? `${currentPetLabel} 还有 ${summary.pending_count} 个待提醒事项，切换后不会提醒。确定切换吗？`
            : `${currentPetLabel} has ${summary.pending_count} pending reminders. They will not trigger after switching. Continue?`,
        )
        if (!confirmed) {
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
        }),
        12000,
        'update_preferences_timeout',
      )
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
      setUser((current) => (current ? { ...current, preferences: nextPreferences } : current))
      await logDesktopDebug({
        event: 'main-panel-switch-success',
        petType: switchedResult?.state?.petType || nextPetType,
        totalElapsedMs: Date.now() - startedAt,
      })
      setStatusText(t(language, 'petPreferenceSaved'))
    } catch (error) {
      await logDesktopDebug({
        event: 'main-panel-switch-failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
    } finally {
      setSavingPet(false)
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

  const handleLogout = async () => {
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
    await window.desktopBridge?.syncPetState?.({
      source: 'main-panel',
      hasSession: false,
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
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setKnowledgeStatusText('')
    setKnowledgeSources([])
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
    <div className="window-shell">
      <div className="window-card" style={{ gap: 18 }}>
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
                style={{ background: tab === 'chat' ? '#cbd5e1' : '#e2e8f0' }}
                onClick={() => setTab('chat')}
              >
                {t(language, 'chat')}
              </button>
              <button
                type="button"
                className="button-secondary"
                style={{ background: tab === 'knowledge' ? '#cbd5e1' : '#e2e8f0' }}
                onClick={() => setTab('knowledge')}
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
              <button type="button" className="button-primary" onClick={handleLogout}>
                {t(language, 'signOut')}
              </button>
            </div>
          </div>
          {statusText && <div style={{ marginTop: 12, fontSize: 13, color: '#475569' }}>{statusText}</div>}
        </div>

        {tab === 'chat' ? (
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
