import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'

import './desktop.css'
import {
  checkApiConnection,
  clearSessionToken,
  desktopApi,
  getApiBaseUrl,
  getSessionToken,
  login,
  setApiBaseUrl,
} from './shared/api'

function formatError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage
}

function LoginView({ apiBaseUrl, onApiBaseUrlChange, onSaveApiBaseUrl, onLoggedIn, statusText }) {
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
      setError(formatError(connectionError, 'Unable to reach the Detachym service.'))
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
        title: 'Detachym',
        body: 'Desktop client login succeeded.',
      })
      await onLoggedIn()
    } catch (loginError) {
      setError(formatError(loginError, 'Login failed.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="window-shell" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="panel" style={{ width: 520, padding: 28 }}>
        <div style={{ fontSize: 12, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#64748b' }}>
          Desktop Access
        </div>
        <div style={{ marginTop: 16, fontSize: 36, fontWeight: 700 }}>Detachym Desktop</div>
        <p style={{ marginTop: 12, color: '#475569', lineHeight: 1.8 }}>
          Configure the server address first, then sign in to use chat sessions and knowledge base tools.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14, marginTop: 24 }}>
          <input
            className="input"
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            placeholder="Server URL, for example https://your-domain.com/api/v1"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="button-secondary" type="button" onClick={handleTestConnection} disabled={testing || loading}>
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
          <input
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username or email"
          />
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
          />
          {(error || statusText) && <div style={{ color: error ? '#be123c' : '#475569', fontSize: 14 }}>{error || statusText}</div>}
          <button className="button-primary" type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
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
  const [loading, setLoading] = useState(false)
  const [apiBaseUrl, setApiBaseUrlState] = useState('')

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

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
  }

  const handleSaveApiBaseUrl = async () => {
    const verifiedApiBaseUrl = await checkApiConnection(apiBaseUrl)
    await setApiBaseUrl(verifiedApiBaseUrl)
    setApiBaseUrlState(verifiedApiBaseUrl)
    setStatusText('Server connection verified.')
    return verifiedApiBaseUrl
  }

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const savedApiBaseUrl = await getApiBaseUrl()
        if (active) {
          setApiBaseUrlState(savedApiBaseUrl || '')
        }

        const token = await getSessionToken()
        if (!token || !savedApiBaseUrl) {
          return
        }

        await loadDashboard()
      } catch (error) {
        if (active) {
          setAuthenticated(false)
          setStatusText(formatError(error, 'Unable to initialize the desktop client.'))
        }
      } finally {
        if (active) {
          setInitialized(true)
        }
      }
    }

    bootstrap()

    return () => {
      active = false
    }
  }, [])

  const handleSend = async () => {
    if (!prompt.trim() || loading) {
      return
    }

    const outgoingMessage = prompt.trim()
    setPrompt('')
    setLoading(true)
    setStatusText('Waiting for a response...')
    setMessages((current) => [...current, { role: 'user', content: outgoingMessage }])

    try {
      const response = await desktopApi.sendMessage({
        message: outgoingMessage,
        session_id: activeSessionId ?? undefined,
        use_rag: useRag,
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
      setStatusText('Latest response received.')
    } catch (error) {
      setStatusText(formatError(error, 'Message delivery failed.'))
    } finally {
      setLoading(false)
    }
  }

  const handleSelectSession = async (sessionId) => {
    try {
      const session = await desktopApi.getSession(sessionId)
      setActiveSessionId(session.id)
      setMessages(session.messages || [])
    } catch (error) {
      setStatusText(formatError(error, 'Unable to load the session.'))
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
      setStatusText('Document uploaded and indexed.')
    } catch (error) {
      setStatusText(formatError(error, 'Upload failed.'))
    } finally {
      event.target.value = ''
    }
  }

  const handleDeleteDocument = async (documentId) => {
    try {
      await desktopApi.deleteDocument(documentId)
      setDocuments((current) => current.filter((item) => item.id !== documentId))
      setStatusText('Document deleted.')
    } catch (error) {
      setStatusText(formatError(error, 'Delete failed.'))
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
    setStatusText('Signed out.')
  }

  const handleServerSetup = async () => {
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
    setStatusText('Update the server URL and sign in again.')
  }

  if (!initialized) {
    return (
      <div className="window-shell" style={{ display: 'grid', placeItems: 'center' }}>
        Starting the desktop client...
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
      />
    )
  }

  return (
    <div className="window-shell">
      <div className="window-card" style={{ gap: 18 }}>
        <div className="panel" style={{ padding: 18 }}>
          <div className="toolbar">
            <div>
              <div style={{ fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#64748b' }}>
                Desktop Main Panel
              </div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>Welcome, {user?.username}</div>
              <div style={{ marginTop: 8, fontSize: 13, color: '#64748b' }}>Server: {apiBaseUrl}</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="button-secondary" onClick={() => setTab('chat')}>
                Chat
              </button>
              <button type="button" className="button-secondary" onClick={() => setTab('knowledge')}>
                Knowledge Base
              </button>
              <button type="button" className="button-secondary" onClick={handleServerSetup}>
                Change Server
              </button>
              <button type="button" className="button-primary" onClick={handleLogout}>
                Sign Out
              </button>
            </div>
          </div>
          {statusText && <div style={{ marginTop: 12, fontSize: 13, color: '#475569' }}>{statusText}</div>}
        </div>

        {tab === 'chat' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 18, flex: 1, minHeight: 0 }}>
            <aside className="panel" style={{ padding: 18, overflow: 'auto' }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Sessions</div>
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
                {sessions.length === 0 && (
                  <div style={{ color: '#64748b', fontSize: 14 }}>
                    No session yet. Send the first message to create one.
                  </div>
                )}
              </div>
            </aside>

            <section className="panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="toolbar" style={{ marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                    Current Session
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{activeSession?.title || 'New Session'}</div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
                  Enable knowledge base
                </label>
              </div>

              <div className="chat-stream" style={{ flex: 1, minHeight: 0 }}>
                {messages.length === 0 && (
                  <div className="message assistant">
                    The desktop panel connects to the cloud API. Ask questions here and optionally use your private
                    knowledge base.
                  </div>
                )}
                {messages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={`message ${item.role}`}>
                    {item.content}
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
                <textarea
                  className="textarea"
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Type a message for the cloud assistant..."
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="button-primary" onClick={handleSend} disabled={loading}>
                    {loading ? 'Sending...' : 'Send Message'}
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
                  Knowledge Base
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>Manage Documents</div>
              </div>
              <label className="button-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Upload Document
                <input type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleUpload} />
              </label>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {documents.length === 0 ? (
                <div style={{ fontSize: 14, color: '#64748b' }}>No document uploaded yet.</div>
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
                        {document.status} | {document.chunk_count} chunks | {Math.round((document.file_size || 0) / 1024)} KB
                      </div>
                    </div>
                    <button type="button" className="button-secondary" onClick={() => handleDeleteDocument(document.id)}>
                      Delete
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
