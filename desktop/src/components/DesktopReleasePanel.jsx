import { useEffect, useRef, useState } from 'react'
import { fetchDesktopRelease, getDesktopReleaseStatus } from '../shared/desktop-release'

export function DesktopReleasePanel({ language, apiBaseUrl }) {
  const zh = language === 'zh-CN'
  const [result, setResult] = useState(null)
  const [currentVersion, setCurrentVersion] = useState('')
  const [status, setStatus] = useState('idle')
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState(false)
  const active = useRef(null)
  const mounted = useRef(false)
  const checked = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.abort() }
  }, [])

  async function check() {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    checked.current = true
    setStatus('checking')
    setOpenError(false)
    try {
      const [installedVersion, release] = await Promise.all([
        window.desktopBridge.getAppVersion().then((version) => {
          if (mounted.current && !controller.signal.aborted) setCurrentVersion(version)
          return version
        }),
        fetchDesktopRelease(apiBaseUrl, { signal: controller.signal }),
      ])
      const nextStatus = getDesktopReleaseStatus(installedVersion, release)
      if (!mounted.current || controller.signal.aborted) return
      setResult({ version: release.version })
      setStatus(nextStatus)
    } catch {
      if (mounted.current && !controller.signal.aborted) setStatus('error')
    }
  }

  async function openDownload() {
    if (opening) return
    setOpening(true)
    setOpenError(false)
    try {
      await window.desktopBridge.openDesktopDownloadPage(apiBaseUrl)
    } catch {
      if (mounted.current) setOpenError(true)
    } finally {
      if (mounted.current) setOpening(false)
    }
  }

  const messages = zh ? {
    checking: '正在检查发布版本…', error: '暂时无法检查版本，请重试。',
    update: `有新版本 ${result?.version || ''} 可以下载。`, current: '当前已是最新发布版本。',
    ahead: '当前客户端比此服务的发布版本更新。', unavailable: '此服务的安装包暂未发布。',
  } : {
    checking: 'Checking the release…', error: 'Could not check the release. Please retry.',
    update: `Version ${result?.version || ''} is available.`, current: 'You have the latest published version.',
    ahead: 'This client is newer than this service’s release.', unavailable: 'This service has no published installer yet.',
  }

  return <details className="desktop-release-panel" data-e2e="desktop-release" onToggle={(event) => {
    if (event.currentTarget.open && !checked.current) void check()
  }}>
    <summary>{zh ? '客户端版本' : 'Client version'}</summary>
    {currentVersion && <p data-e2e="desktop-current-version">{zh ? '当前版本' : 'Current version'} {currentVersion}</p>}
    <p role={status === 'error' ? 'alert' : 'status'} data-e2e="desktop-release-status" data-release-status={status}>{messages[status]}</p>
    <div className="desktop-release-actions">
      <button type="button" className="main-header-action" disabled={status === 'checking'} data-e2e="desktop-release-check" onClick={() => void check()}>{zh ? '检查更新' : 'Check for updates'}</button>
      {status === 'update' && <button type="button" className="main-header-action" disabled={opening} data-e2e="desktop-release-download" onClick={() => void openDownload()}>{zh ? '打开下载页' : 'Open download page'}</button>}
    </div>
    {openError && <p role="alert">{zh ? '下载页未能打开，请重新检查后重试。' : 'Could not open the download page. Check again and retry.'}</p>}
    <p className="desktop-release-note">{zh ? '你可以继续使用，更新由你决定。' : 'Keep using the app and update whenever you choose.'}</p>
  </details>
}
