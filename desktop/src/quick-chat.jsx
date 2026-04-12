import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import { clearSessionToken, desktopApi, getApiBaseUrl, getSessionToken } from './shared/api'

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

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const [token, apiBaseUrl] = await Promise.all([getSessionToken(), getApiBaseUrl()])
        if (!active) {
          return
        }
        setHasToken(Boolean(token))
        setHasApiBaseUrl(Boolean(apiBaseUrl))
      } catch {
        if (active) {
          setHasToken(false)
          setHasApiBaseUrl(false)
        }
      } finally {
        if (active) {
          setReady(true)
        }
      }
    }

    bootstrap()

    return () => {
      active = false
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
      })
      setSessionId(response.session_id)
      setMessages((current) => [...current, { role: 'assistant', content: response.content }])
    } catch (error) {
      const detail = formatError(error, 'Request failed.')
      setMessages((current) => [...current, { role: 'assistant', content: detail }])
      if (detail.toLowerCase().includes('validate credentials')) {
        await clearSessionToken()
        setHasToken(false)
      }
    } finally {
      setLoading(false)
    }
  }

  const needsSetup = !hasToken || !hasApiBaseUrl

  return (
    <div className="window-shell">
      <div className="window-card">
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18, flex: 1 }}>
          <div className="toolbar">
            <div>
              <div style={{ fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#64748b' }}>
                Quick Chat
              </div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>Desktop Quick Chat</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
              Enable knowledge base
            </label>
          </div>

          {!ready ? (
            <div className="panel" style={{ padding: 18, background: '#e2e8f0' }}>
              Starting quick chat...
            </div>
          ) : needsSetup ? (
            <div className="panel" style={{ padding: 18, background: '#e2e8f0' }}>
              <div style={{ fontSize: 14, color: '#334155', lineHeight: 1.8 }}>
                Open the main panel first, configure the server URL, and sign in to your cloud account before using quick
                chat.
              </div>
              <button
                type="button"
                className="button-primary"
                style={{ marginTop: 14 }}
                onClick={() => window.desktopBridge?.openMainPanel?.()}
              >
                Open Main Panel
              </button>
            </div>
          ) : (
            <>
              <div className="chat-stream" style={{ flex: 1, minHeight: 360 }}>
                {messages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={`message ${item.role}`}>
                    {item.content}
                  </div>
                ))}
                {messages.length === 0 && (
                  <div className="message assistant">
                    Ask a question here after clicking the pet. The desktop client will use your current cloud account and
                    knowledge base settings.
                  </div>
                )}
              </div>

              <textarea
                className="textarea"
                rows={4}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Type a question for Detachym..."
              />
              <div className="toolbar">
                <button type="button" className="button-secondary" onClick={() => window.desktopBridge?.openMainPanel?.()}>
                  Open Main Panel
                </button>
                <button type="button" className="button-primary" onClick={sendMessage} disabled={loading}>
                  {loading ? 'Sending...' : 'Send'}
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
