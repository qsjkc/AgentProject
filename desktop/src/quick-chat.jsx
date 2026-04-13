import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { clearSessionToken, desktopApi, getApiBaseUrl, getLanguage, getSessionToken } from './shared/api'
import { normalizeLanguage, t } from './shared/i18n'
import { getPetVisual } from './shared/pets'

function formatError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage
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

  const petLabel = useMemo(() => t(language, getPetVisual(petType, 'idle').labelKey), [language, petType])

  useEffect(() => {
    let active = true

    const syncState = async () => {
      try {
        const [token, apiBaseUrl, savedLanguage] = await Promise.all([
          getSessionToken(),
          getApiBaseUrl(),
          getLanguage(),
        ])

        if (!active) {
          return
        }

        setHasToken(Boolean(token))
        setHasApiBaseUrl(Boolean(apiBaseUrl))
        setLanguage(normalizeLanguage(savedLanguage))

        if (!token || !apiBaseUrl) {
          setPetType('cat')
          return
        }

        const preferences = await desktopApi.getPreferences()
        if (!active) {
          return
        }

        setPetType(preferences?.pet_type || 'cat')
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

    return () => {
      active = false
      window.removeEventListener('focus', syncState)
    }
  }, [])

  const sendMessage = async () => {
    if (!message.trim() || loading) {
      return
    }

    const outgoingMessage = message.trim()
    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])
    setMessage('')
    setLoading(true)

    try {
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: sessionId ?? undefined,
        use_rag: useRag,
        pet_type: petType,
      })
      setSessionId(response.session_id)
      setMessages((current) => [...current, { role: 'assistant', content: response.content }])
    } catch (error) {
      const detail = formatError(error, t(language, 'messageDeliveryFailed'))
      setMessages((current) => [...current, { role: 'assistant', content: detail }])
      if (detail.toLowerCase().includes('validate credentials')) {
        await clearSessionToken()
        setHasToken(false)
      }
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
        <div className="panel panel-quick-chat">
          <div className="drag-bar">
            <div>
              <div className="eyebrow">{t(language, 'quickChat')}</div>
              <div className="quick-chat-title">{t(language, 'desktopQuickChat', { pet: petLabel })}</div>
              <div className="drag-bar-hint">
                {t(language, 'dragWindowHint')} · {t(language, 'enterToSendHint')}
              </div>
            </div>
            <label className="quick-chat-toggle no-drag">
              <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
              {t(language, 'enableKnowledgeBase')}
            </label>
          </div>

          {!ready ? (
            <div className="panel panel-muted">{t(language, 'startingQuickChat')}</div>
          ) : needsSetup ? (
            <div className="panel panel-muted">
              <div className="panel-copy">{t(language, 'quickChatSetupText')}</div>
              <button
                type="button"
                className="button-primary no-drag"
                style={{ marginTop: 14 }}
                onClick={() => window.desktopBridge?.openMainPanel?.()}
              >
                {t(language, 'openMainPanel')}
              </button>
            </div>
          ) : (
            <>
              <div className="chat-stream chat-stream-quick">
                {messages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={`message ${item.role}`}>
                    {item.content}
                  </div>
                ))}
                {messages.length === 0 && (
                  <div className="message assistant">{t(language, 'quickChatEmpty', { pet: petLabel })}</div>
                )}
              </div>

              <textarea
                className="textarea no-drag"
                rows={4}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={t(language, 'quickChatPlaceholder', { pet: petLabel })}
              />
              <div className="toolbar">
                <button
                  type="button"
                  className="button-secondary no-drag"
                  onClick={() => window.desktopBridge?.openMainPanel?.()}
                >
                  {t(language, 'openMainPanel')}
                </button>
                <button type="button" className="button-primary no-drag" onClick={sendMessage} disabled={loading}>
                  {loading ? t(language, 'sending') : t(language, 'send')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<QuickChatApp />)
