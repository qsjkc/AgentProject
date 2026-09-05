import { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import {
  captureApiOperationContext,
  desktopApi,
  getApiBaseUrl,
  getLanguage,
  getSessionSnapshot,
} from './shared/api'
import {
  adoptRelationshipCapability,
  adoptPetStateCapability,
  commitAccountOperation,
  createAccountOperationGate,
  deriveQuickChatPetStateContext,
  isAuthContextChangedError,
} from './shared/pet-account-context'
import { normalizeLanguage, t } from './shared/i18n'
import { getPetReminderCopy } from './shared/pet-personality'
import { getPetRelationship } from './shared/pet-relationships-api'
import { getPetVisual } from './shared/pets'
import { PET_ONBOARDING_CAPABILITIES } from './shared/pet-onboarding-main'
import { parseReminder } from './shared/reminder-parser'
import {
  getBrowserTimeZone,
  getReminderRecurrenceLabel,
} from './shared/reminder-recurrence'
import { createReminder } from './shared/reminders-api'

function formatError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage
}

async function logDesktopDebug(payload) {
  try {
    await window.desktopBridge?.logDebug?.(payload)
  } catch {
    // no-op
  }
}

function formatCompactReply(content, language) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return t(language, 'messageDeliveryFailed')
  }

  if (normalized.length <= 72) {
    return normalized
  }

  return `${normalized.slice(0, 72).trim()}... ${t(language, 'openMainPanelForMore')}`
}

function truncateReply(content, language) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return t(language, 'messageDeliveryFailed')
  }

  if (normalized.length <= 72) {
    return normalized
  }

  return `${normalized.slice(0, 72).trim()}… ${t(language, 'openMainPanelForMore')}`
}

function getQuickChatIntro(language, petLabel) {
  if (language === 'zh-CN') {
    return `桌宠单击现在会进入语音态。这里继续保留给 ${petLabel} 的文字快捷聊天。`
  }

  return `Single-clicking the pet now enters voice mode. This window stays available for quick text chat with ${petLabel}.`
}

function QuickChatApp() {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [useRag, setUseRag] = useState(true)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [hasToken, setHasToken] = useState(false)
  const [hasApiBaseUrl, setHasApiBaseUrl] = useState(false)
  const [language, setLanguage] = useState('zh-CN')
  const [petType, setPetType] = useState('cat')
  const petContextRef = useRef({
    hasSession: false,
    petType: 'cat',
    userId: null,
    session: null,
    authoritative: null,
  })
  const syncEpochRef = useRef(0)
  const reminderGateRef = useRef(null)
  const chatGateRef = useRef(null)
  if (!reminderGateRef.current) reminderGateRef.current = createAccountOperationGate()
  if (!chatGateRef.current) chatGateRef.current = createAccountOperationGate()
  petContextRef.current.petType = petType

  const petVisual = useMemo(() => getPetVisual(petType, 'idle'), [petType])
  const petLabel = useMemo(() => t(language, petVisual.labelKey), [language, petVisual.labelKey])
  const recentMessages = messages.slice(-4)

  useEffect(() => {
    let active = true
    let syncId = 0

    const syncState = async () => {
      const requestId = ++syncId
      const syncEpoch = syncEpochRef.current
      try {
        const [apiBaseUrl, savedLanguage, petState] = await Promise.all([
          getApiBaseUrl(),
          getLanguage(),
          window.desktopBridge?.getPetState?.(),
        ])

        if (!active || requestId !== syncId) {
          return
        }
        // Configuration is independent of account capability hydration. A focus
        // refresh must not cancel an in-flight trusted pet-state broadcast.
        setHasApiBaseUrl(Boolean(apiBaseUrl))
        setLanguage(normalizeLanguage(savedLanguage))
        if (syncEpochRef.current !== syncEpoch) return
        const operationContext = await captureApiOperationContext({
          ...petContextRef.current,
          userId: petState?.userId ?? null,
          petType: petState?.petType || 'cat',
        }, 'pet')
        if (!active || requestId !== syncId || syncEpochRef.current !== syncEpoch) return

        const token = operationContext?.session?.token
        setHasToken(Boolean(token))

        if (petState?.petType) {
          setPetType(petState.petType)
        }
        petContextRef.current = {
          hasSession: Boolean(token),
          petType: petState?.petType || 'cat',
          userId: petState?.userId ?? null,
          session: operationContext?.session || null,
          authoritative: operationContext?.authoritative || null,
        }

        if (!token || !apiBaseUrl) {
          setPetType(petState?.petType || 'cat')
          return
        }

        const preferences = await desktopApi.getPreferences(operationContext)
        if (!active || requestId !== syncId || syncEpochRef.current !== syncEpoch) {
          return
        }

        const nextPetType = preferences?.pet_type || 'cat'
        setPetType(nextPetType)
        petContextRef.current = {
          hasSession: true,
          petType: nextPetType,
          userId: petState?.userId ?? null,
          session: operationContext.session,
          authoritative: operationContext.authoritative,
        }
        await logDesktopDebug({
          event: 'quick-chat-sync-session',
          petType: preferences?.pet_type || petState?.petType || 'cat',
          hasToken: Boolean(token),
          hasApiBaseUrl: Boolean(apiBaseUrl),
        })
      } catch (error) {
        void logDesktopDebug({ event: 'quick-chat-sync-failed', reason: error?.message })
        if (active && requestId === syncId && syncEpochRef.current === syncEpoch && !isAuthContextChangedError(error)) {
          setHasToken(false)
          setHasApiBaseUrl(false)
          setLanguage('zh-CN')
          setPetType('cat')
          petContextRef.current = { hasSession: false, petType: 'cat', userId: null, session: null }
        }
      } finally {
        if (active && requestId === syncId) {
          setReady(true)
        }
      }
    }

    void syncState()
    window.addEventListener('focus', syncState)
    void logDesktopDebug({ event: 'quick-chat-runtime-ready' })

    return () => {
      active = false
      syncEpochRef.current += 1
      window.removeEventListener('focus', syncState)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetRelationshipChanged?.((payload) => {
      if (!payload || typeof payload !== 'object') return
      const epoch = syncEpochRef.current
      void (async () => {
        const adopted = await adoptRelationshipCapability({
          payload,
          currentContext: petContextRef.current,
          validateCapability: (capability, requiredScope, semantic) => (
            window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
          ),
        })
        if (!adopted || syncEpochRef.current !== epoch) return
        petContextRef.current = {
          ...petContextRef.current,
          relationshipId: adopted.relationship.id,
          authoritative: adopted.authoritative,
          local: adopted.local,
        }
      })()
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetStateChanged?.((payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      if (payload.language) {
        setLanguage(normalizeLanguage(payload.language))
      }

      if (payload.petType) {
        setPetType(payload.petType)
      }
      const transition = deriveQuickChatPetStateContext(petContextRef.current, payload)
      const { context: nextContext, identityChanged } = transition
      if (identityChanged) {
        syncEpochRef.current += 1
        reminderGateRef.current.invalidate()
        chatGateRef.current.invalidate()
        setLoading(false)
        setMessages([])
        setSessionId(null)
      }
      petContextRef.current = nextContext

      if (identityChanged) {
        setHasToken(false)
      }
      const stateEpoch = syncEpochRef.current
      if (nextContext.hasSession && payload.authoritative) {
        void adoptPetStateCapability({
          payload,
          currentContext: nextContext,
          validateCapability: (capability, requiredScope, semantic) => (
            window.desktopBridge?.renewOperationContext?.(capability, requiredScope, semantic)
          ),
        }).then(async (adopted) => {
          const session = adopted ? await getSessionSnapshot() : null
          if (adopted && syncEpochRef.current === stateEpoch) {
            const previousSession = petContextRef.current.session
            if (previousSession && (previousSession.token !== session?.token
              || previousSession.generation !== session?.generation)) {
              syncEpochRef.current += 1
              reminderGateRef.current.invalidate()
              chatGateRef.current.invalidate()
              setLoading(false)
              setMessages([])
              setSessionId(null)
            }
            petContextRef.current = {
              ...petContextRef.current,
              authoritative: adopted.authoritative,
              session,
              local: adopted.local,
            }
            setHasToken(Boolean(session?.token))
          }
        }).catch(() => undefined)
        return
      }
      if (transition.needsRecapture) {
        void getSessionSnapshot().then(async (session) => {
          const initiating = { ...nextContext, session }
          const operationContext = await captureApiOperationContext(initiating, 'pet')
          if (
            syncEpochRef.current === stateEpoch
            && petContextRef.current.hasSession
            && Number(petContextRef.current.userId) === Number(nextContext.userId)
            && petContextRef.current.petType === nextContext.petType
          ) {
            petContextRef.current = operationContext
            setHasToken(Boolean(operationContext.session?.token))
          }
        }).catch(() => undefined)
      } else if (!nextContext.hasSession) {
        setHasToken(false)
      } else if (!identityChanged) {
        setHasToken(Boolean(nextContext.session?.token))
      }
      void logDesktopDebug({
        event: 'quick-chat-pet-state-changed',
        petType: payload.petType || null,
        hasSession: payload.hasSession,
        source: payload.source || 'unknown',
        txId: payload.txId ?? null,
      })
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
        view: 'quick-chat',
        ready,
        hasToken,
        hasApiBaseUrl,
        petType,
        sessionId,
        useRag,
        loading,
        recentMessageCount: recentMessages.length,
        lastMessageRole: recentMessages.length > 0 ? recentMessages[recentMessages.length - 1]?.role : null,
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
  }, [ready, hasToken, hasApiBaseUrl, petType, sessionId, useRag, loading, recentMessages])

  const sendMessage = async () => {
    if (!message.trim() || loading) {
      return
    }

    if (!petContextRef.current.authoritative) {
      return
    }

    const outgoingMessage = message.trim()
    const parsedReminder = parseReminder(outgoingMessage)
    if (parsedReminder.ok) {
      let reminderContext = reminderGateRef.current.begin({ ...petContextRef.current })
      setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])
      setMessage('')
      setLoading(true)
      try {
        const operationContext = await captureApiOperationContext(reminderContext, 'pet')
        const reminder = await createReminder({
          pet_type: reminderContext.petType,
          title: parsedReminder.title,
          source_text: parsedReminder.sourceText,
          remind_at: parsedReminder.remindAt.toISOString(),
          recurrence_type: parsedReminder.recurrenceType,
          recurrence_timezone: parsedReminder.recurrenceType === 'once'
            ? null
            : getBrowserTimeZone(),
        }, operationContext)
        if (
          !reminderGateRef.current.isCurrent(reminderContext, petContextRef.current)
          || Number(reminder.user_id) !== Number(reminderContext.userId)
        ) {
          return
        }
        try {
          const nextRelationship = await getPetRelationship(
            reminderContext.petType,
            reminderContext,
          )
          if (
            !reminderGateRef.current.isCurrent(reminderContext, petContextRef.current)
            || Number(nextRelationship?.user_id) !== Number(reminderContext.userId)
            || nextRelationship?.pet_type !== reminderContext.petType
          ) return
          const cacheResult = await window.desktopBridge?.cachePetRelationship?.(
            nextRelationship,
            reminderContext,
          )
          if (!cacheResult?.ok || !cacheResult.authoritative) return
          petContextRef.current = {
            ...petContextRef.current,
            relationshipId: nextRelationship.id,
            authoritative: cacheResult.authoritative,
          }
          reminderContext = reminderGateRef.current.begin({ ...petContextRef.current })
        } catch (error) {
          await logDesktopDebug({
            event: 'quick-chat-relationship-refresh-failed',
            source: 'reminder-created',
            reason: error instanceof Error ? error.message : String(error),
          })
          return
        }
        if (
          petType === 'pig'
          && reminderContext.petType === 'pig'
          && petContextRef.current.petType === reminderContext.petType
          && Number.isInteger(Number(reminderContext.userId))
          && Number(reminderContext.userId) > 0
          && Number(petContextRef.current.userId) === Number(reminderContext.userId)
          && Number(reminder.user_id) === Number(reminderContext.userId)
        ) {
          const onboardingResult = await window.desktopBridge?.recordPetOnboardingObservation?.(
            'pig',
            PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
            { reminderId: reminder.id },
            reminderContext,
          )
          if (!reminderGateRef.current.isCurrent(reminderContext, petContextRef.current)) {
            return
          }
          if (onboardingResult === undefined || onboardingResult?.ok === false) {
            await logDesktopDebug({
              event: 'quick-chat-onboarding-reminder-observation-rejected',
              reason: onboardingResult?.reason || 'onboarding_bridge_unavailable',
              reminderId: reminder.id,
            })
            if (!reminderGateRef.current.isCurrent(reminderContext, petContextRef.current)) {
              return
            }
          }
        }
        if (!reminderGateRef.current.isCurrent(reminderContext, petContextRef.current)) {
          return
        }
        const confirmedRemindAt = new Date(reminder.remind_at)
        const timeText = confirmedRemindAt.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        const copy = getPetReminderCopy(reminderContext.petType).createdReminder(
          reminder.title,
          timeText,
          reminder.email_enabled,
          getReminderRecurrenceLabel(
            reminder.recurrence_type,
            reminder.remind_at,
            language,
          ),
        )
        commitAccountOperation(
          reminderGateRef.current,
          reminderContext,
          petContextRef.current,
          () => setMessages((current) => [...current, { role: 'assistant', content: copy }]),
        )
        await window.desktopBridge?.notifyPetReminderEvent?.({
          type: 'created',
          petType: reminderContext.petType,
          title: reminder.title,
          message: copy,
          reminderId: reminder.id,
        }, reminderContext)
      } catch (error) {
        const detail = formatError(error, t(language, 'messageDeliveryFailed'))
        commitAccountOperation(
          reminderGateRef.current,
          reminderContext,
          petContextRef.current,
          () => setMessages((current) => [...current, { role: 'assistant', content: detail }]),
        )
      } finally {
        commitAccountOperation(
          reminderGateRef.current,
          reminderContext,
          petContextRef.current,
          () => setLoading(false),
        )
      }
      return
    }
    if (parsedReminder.reason === 'missing_time') {
      const copy = getPetReminderCopy(petType).parseFailed
      setMessages((current) => [
        ...current,
        { role: 'user', content: outgoingMessage },
        { role: 'assistant', content: copy },
      ])
      setMessage('')
      await window.desktopBridge?.notifyPetReminderEvent?.({
        type: 'parse_failed',
        petType,
        message: copy,
      }, petContextRef.current)
      return
    }

    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])
    setMessage('')
    setLoading(true)
    const requestContext = chatGateRef.current.begin({ ...petContextRef.current })

    try {
      await logDesktopDebug({
        event: 'quick-chat-send-start',
        petType,
        hasSessionId: Boolean(sessionId),
      })
      const operationContext = await captureApiOperationContext(requestContext, 'pet')
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: sessionId ?? undefined,
        use_rag: useRag,
        pet_type: petType,
        compact_response: true,
      }, operationContext)
      if (!chatGateRef.current.isCurrent(requestContext, petContextRef.current)) {
        return
      }
      setSessionId(response.session_id)
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: formatCompactReply(response.content, language),
          knowledgeUsed: Boolean(response.knowledge_used),
          sourceCount: response.sources?.length || 0,
        },
      ])
      await logDesktopDebug({
        event: 'quick-chat-send-success',
        petType,
        sessionId: response.session_id,
      })
      if (!chatGateRef.current.isCurrent(requestContext, petContextRef.current)) {
        return
      }
    } catch (error) {
      const detail = formatError(error, t(language, 'messageDeliveryFailed'))
      if (chatGateRef.current.isCurrent(requestContext, petContextRef.current)) {
        setMessages((current) => [...current, { role: 'assistant', content: detail }])
        if (detail.toLowerCase().includes('validate credentials')) {
          setHasToken(false)
        }
        await logDesktopDebug({
          event: 'quick-chat-send-failed',
          petType: requestContext.petType,
          reason: detail,
        })
      }
    } finally {
      commitAccountOperation(
        chatGateRef.current,
        requestContext,
        petContextRef.current,
        () => setLoading(false),
      )
    }
  }

  const handleInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const needsSetup = !hasToken || !hasApiBaseUrl

  return (
    <div className="window-shell window-shell-quick-chat">
      <div className="window-card window-card-quick-chat">
        <div className="quick-chat-stage">
          <div className="quick-chat-orb quick-chat-orb-left" />
          <div className="quick-chat-orb quick-chat-orb-right" />

          <div className="quick-chat-bubble-card window-drag-handle">
            <div className="quick-chat-bubble-tail" />
            <div className="quick-chat-hero">
              <div className="quick-chat-mascot-frame">
                <img className="quick-chat-pet-avatar" src={petVisual.image} alt={petLabel} />
              </div>
              <div className="quick-chat-hero-copy">
                <div className="quick-chat-chip">{t(language, 'quickChat')}</div>
                <div className="quick-chat-title">{t(language, 'desktopQuickChat', { pet: petLabel })}</div>
                <div className="quick-chat-subtitle">{getQuickChatIntro(language, petLabel)}</div>
              </div>
              <button
                type="button"
                className="quick-chat-main-link no-drag"
                onClick={() => window.desktopBridge?.openMainPanel?.()}
              >
                {t(language, 'openMainPanel')}
              </button>
            </div>

            {!ready ? (
              <div className="quick-chat-state">{t(language, 'startingQuickChat')}</div>
            ) : needsSetup ? (
              <div className="quick-chat-state quick-chat-state-card">
                <div className="quick-chat-state-copy">{t(language, 'quickChatSetupText')}</div>
                <button type="button" className="quick-chat-send no-drag" onClick={() => window.desktopBridge?.openMainPanel?.()}>
                  {t(language, 'openMainPanel')}
                </button>
              </div>
            ) : (
              <>
                <div className="quick-chat-thread">
                  {recentMessages.length === 0 && (
                    <div className="quick-chat-message assistant quick-chat-message-empty">
                      {getQuickChatIntro(language, petLabel)}
                    </div>
                  )}
                  {recentMessages.map((item, index) => (
                    <div
                      key={`${item.role}-${index}`}
                      className={`quick-chat-message ${item.role}`}
                      data-e2e={item.role === 'assistant' ? 'quick-chat-assistant-message' : undefined}
                    >
                      <div className={`quick-chat-message-body ${item.role}`}>{item.content}</div>
                      {item.role === 'assistant' && item.knowledgeUsed && (
                        <div className="quick-chat-footnote">
                          {t(language, 'knowledgeHitHint', { count: item.sourceCount || 1 })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="quick-chat-input-wrap">
                  <div className="quick-chat-composer">
                    <textarea
                      className="quick-chat-input no-drag"
                      data-e2e="quick-chat-input"
                      rows={3}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={handleInputKeyDown}
                      placeholder={t(language, 'quickChatPlaceholder', { pet: petLabel })}
                    />
                    <div className="quick-chat-toolbar">
                      <label className="quick-chat-toggle no-drag">
                        <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
                        <span>{t(language, 'enableKnowledgeBase')}</span>
                      </label>
                      <button
                        type="button"
                        className="quick-chat-send no-drag"
                        data-e2e="quick-chat-send"
                        onClick={sendMessage}
                        disabled={loading}
                      >
                        {loading ? t(language, 'sending') : t(language, 'send')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<QuickChatApp />)
