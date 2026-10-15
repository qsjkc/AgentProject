import { useDesktopRelease } from '../hooks/useDesktopRelease'
import { resolveDownloadUrl } from '../services'

const steps = [
  { title: '安装到 Windows 电脑', description: '下载安装包，打开文件，按照安装向导完成安装。' },
  { title: '登录你的 Detachym 账号', description: '打开客户端并登录。还没有账号的话，可以先在网站注册。' },
  { title: '和桌面上的伙伴打个招呼', description: '新账号默认由小猪陪伴。已有账号会保留原来的选择，也可以在偏好中换成小猪。从一次摸摸开始熟悉彼此。' },
]

export default function Download() {
  const { release, loading, error, retry } = useDesktopRelease()

  return (
    <div className="download-page">
      <section aria-labelledby="download-title">
        <span className="home-eyebrow">BRING A LITTLE FRIEND HOME</span>
        <h1 id="download-title">把小猪，<br />带到你的桌面。</h1>
        <p className="download-intro">一个安静的角落，一点有回应的陪伴。<br />下载 Detachym，让今天的相处从这里开始。</p>
        <div className="download-release">
          <span className="download-platform"><span aria-hidden="true">⊞</span> Windows x64</span>
          {loading ? (
            <p role="status" className="download-release-status">正在检查发布状态...</p>
          ) : release && !error ? (
            <div className="download-release-content">
              <div className="download-version-label">当前版本</div>
              <h2>{release.version}</h2>
              <p className="download-filename">{release.filename}</p>
              <p className="download-published">{release.published_at ? `发布时间：${new Date(release.published_at).toLocaleString()}` : '尚未检测到发布时间'}</p>
              {release.available ? (
                <a href={resolveDownloadUrl(release)} className="companion-button companion-button-primary">下载 Windows 安装包 <span aria-hidden="true">↓</span></a>
              ) : (
                <span role="status" aria-disabled="true" className="download-unavailable">安装包暂未发布</span>
              )}
              <p className="download-footnote">请在 Windows 64 位电脑上安装。当前不提供 macOS 或手机版本。</p>
            </div>
          ) : (
            <div className="download-release-content">
              <p role="alert" className="download-release-status">无法获取版本信息，请稍后重试。</p>
              <button type="button" onClick={() => void retry()} className="companion-button companion-button-primary">重新检查 <span aria-hidden="true">↻</span></button>
            </div>
          )}
        </div>
      </section>
      <section className="download-guide" aria-labelledby="download-guide-title">
        <span className="home-eyebrow">YOUR FIRST HELLO</span>
        <h2 id="download-guide-title">很快，就能见面。</h2>
        <ol className="download-steps">
          {steps.map((step, index) => <li key={step.title}><span className="download-step-number" aria-hidden="true">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.description}</p></div></li>)}
        </ol>
        <div className="download-good-to-know"><h3>按照你的节奏相处</h3><p>静音、开机启动和桌宠位置可以在客户端调整。想专心时，也可以先把桌宠收起来。</p><p>使用同一账号时，桌宠偏好会与云端同步。新版本会在本页提供，何时下载和安装由你决定。</p></div>
      </section>
    </div>
  )
}
