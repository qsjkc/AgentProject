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
  login,
  setApiBaseUrl,
  setLanguage,
} from './shared/api'
import { normalizeLanguage, SUPPORTED_LANGUAGES, t } from './shared/i18n'

function formatError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage
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
  const [language, setLanguageState] = useState('zh-CN')

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

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
  }

  const handleSaveApiBaseUrl = async () => {
    const verifiedApiBaseUrl = await checkApiConnection(apiBaseUrl)
    await setApiBaseUrl(verifiedApiBaseUrl)
    setApiBaseUrlState(verifiedApiBaseUrl)
    setStatusText(t(language, 'serverConnectionVerified'))
    return verifiedApiBaseUrl
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

        if (active) {
          setApiBaseUrlState(savedApiBaseUrl || '')
          setLanguageState(normalizeLanguage(savedLanguage))
        }

        if (!token || !savedApiBaseUrl) {
          return
        }

        await loadDashboard()
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

  const handleSend = async () => {
    if (!prompt.trim() || loading) {
      return
    }

    const outgoingMessage = prompt.trim()
    setPrompt('')
    setLoading(true)
    setStatusText(t(language, 'waitingResponse'))
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
      setStatusText(t(language, 'latestResponseReceived'))
    } catch (error) {
      setStatusText(formatError(error, t(language, 'messageDeliveryFailed')))
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

  const handleLogout = async () => {
    await clearSessionToken()
    setAuthenticated(false)
    setUser(null)
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setDocuments([])
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
    setStatusText(t(language, 'updateServerUrlHint'))
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
              <button type="button" className="button-secondary" onClick={handleServerSetup}>
                {t(language, 'changeServer')}
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
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{t(language, 'sessions')}</div>
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
            </aside>

            <section className="panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="toolbar" style={{ marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                    {t(language, 'currentSession')}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{activeSession?.title || t(language, 'newSession')}</div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={useRag} onChange={(event) => setUseRag(event.target.checked)} />
                  {t(language, 'enableKnowledgeBase')}
                </label>
              </div>

              <div className="chat-stream" style={{ flex: 1, minHeight: 0 }}>
                {messages.length === 0 && <div className="message assistant">{t(language, 'desktopPanelIntro')}</div>}
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
                  placeholder={t(language, 'typeMessagePlaceholder')}
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
