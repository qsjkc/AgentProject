import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { clearSessionToken, desktopApi, getApiBaseUrl, getLanguage, getSessionToken } from './shared/api'
import { normalizeLanguage, t } from './shared/i18n'
import { getPetVisual } from './shared/pets'

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

  const petVisual = useMemo(() => getPetVisual(petType, 'idle'), [petType])
  const petLabel = useMemo(() => t(language, petVisual.labelKey), [language, petVisual.labelKey])
  const recentMessages = messages.slice(-4)

  useEffect(() => {
    let active = true

    const syncState = async () => {
      try {
        const [token, apiBaseUrl, savedLanguage, petState] = await Promise.all([
          getSessionToken(),
          getApiBaseUrl(),
          getLanguage(),
          window.desktopBridge?.getPetState?.(),
        ])

        if (!active) {
          return
        }

        setHasToken(Boolean(token))
        setHasApiBaseUrl(Boolean(apiBaseUrl))
        setLanguage(normalizeLanguage(savedLanguage))

        if (petState?.petType) {
          setPetType(petState.petType)
        }

        if (!token || !apiBaseUrl) {
          setPetType(petState?.petType || 'cat')
          return
        }

        const preferences = await desktopApi.getPreferences()
        if (!active) {
          return
        }

        setPetType(preferences?.pet_type || 'cat')
        await logDesktopDebug({
          event: 'quick-chat-sync-session',
          petType: preferences?.pet_type || petState?.petType || 'cat',
          hasToken: Boolean(token),
          hasApiBaseUrl: Boolean(apiBaseUrl),
        })
      } catch {
        if (active) {
          setHasToken(false)
          setHasApiBaseUrl(false)
          setLanguage('zh-CN')
          setPetType('cat')
        }
      } finally {
        if (active) {
          setReady(true)
        }
      }
    }

    void syncState()
    window.addEventListener('focus', syncState)
    void window.desktopBridge?.getRuntimeState?.().then((state) =>
      logDesktopDebug({
        event: 'quick-chat-runtime-state-initial',
        runtimeState: state,
      }),
    )

    return () => {
      active = false
      window.removeEventListener('focus', syncState)
    }
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

      if (typeof payload.hasSession === 'boolean') {
        setHasToken(payload.hasSession)
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

    const outgoingMessage = message.trim()
    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])
    setMessage('')
    setLoading(true)

    try {
      await logDesktopDebug({
        event: 'quick-chat-send-start',
        petType,
        hasSessionId: Boolean(sessionId),
      })
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: sessionId ?? undefined,
        use_rag: useRag,
        pet_type: petType,
        compact_response: true,
      })
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
    } catch (error) {
      const detail = formatError(error, t(language, 'messageDeliveryFailed'))
      setMessages((current) => [...current, { role: 'assistant', content: detail }])
      if (detail.toLowerCase().includes('validate credentials')) {
        await clearSessionToken()
        setHasToken(false)
      }
      await logDesktopDebug({
        event: 'quick-chat-send-failed',
        petType,
        reason: detail,
      })
    } finally {
      setLoading(false)
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
                <div className="quick-chat-subtitle">{t(language, 'quickChatEmpty', { pet: petLabel })}</div>
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
                      {t(language, 'quickChatEmpty', { pet: petLabel })}
                    </div>
                  )}
                  {recentMessages.map((item, index) => (
                    <div key={`${item.role}-${index}`} className={`quick-chat-message ${item.role}`}>
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
                      <button type="button" className="quick-chat-send no-drag" onClick={sendMessage} disabled={loading}>
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
