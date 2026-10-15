import { useState } from 'react'
import { Link } from 'react-router-dom'

import pigIdle from '../assets/pets/pig/idle.png'
import pigHappy from '../assets/pets/pig/happy.png'
import { useDesktopRelease } from '../hooks/useDesktopRelease'

const greetings = ['你忙你的，我就在这里。', '摸摸收到了，今天也一起慢慢来。', '休息一下吧，我帮你守着桌面。']

const moments = [
  { number: '01', icon: '♡', title: '一个摸摸，就有回应', description: '点一点、摸摸它，或把它挪到喜欢的角落。喂食、清洁和小动作，让桌面多一点生活气。', note: '陪伴，从很小的互动开始', tone: 'peach' },
  { number: '02', icon: '◷', title: '小事，轻轻记着', description: '喝水、起身、还有别忘记的事。告诉小猪，它会在桌面提醒你，完成后再一起回到手头的生活。', note: '提醒由你安排，节奏由你决定', tone: 'sage' },
  { number: '03', icon: '✧', title: '相处，会留下痕迹', description: '日常互动累积成亲密度，一起解锁新的装扮。偶尔忙几天也没关系，回来时它还认得这份熟悉。', note: '没有因为缺席而倒退的关系', tone: 'butter' },
]

export default function Home() {
  const { release, loading, error } = useDesktopRelease()
  const [greetingIndex, setGreetingIndex] = useState(0)
  const [hasPetted, setHasPetted] = useState(false)

  return (
    <div className="home-page">
      <section className="companion-hero" aria-labelledby="home-title">
        <div className="hero-copy">
          <span className="home-eyebrow"><span className="presence-dot" /> 给日常，留一点柔软</span>
          <h1 id="home-title">普通的一天，<br />也有<span>小猪陪你。</span></h1>
          <p className="hero-description">住在桌面上的小小伙伴。忙的时候安静待着，<br className="hidden sm:block" />想休息时摸摸它，让喝水、聊天和每次相处都有一点回应。</p>
          <div className="hero-actions">
            <Link to="/download" className="companion-button companion-button-primary">
              遇见你的桌面伙伴 <span aria-hidden="true">↗</span>
            </Link>
            <a href="#moments" className="companion-text-link">看看怎么相处 <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-release" aria-live="polite">
            <span className="windows-mark" aria-hidden="true">⊞</span>
            <span>Windows x64</span><span aria-hidden="true">·</span>
            <span>{loading ? '正在查看发布状态' : error ? '发布信息请前往下载页重试' : release?.available ? '安装包已就绪' : '查看最新发布状态'}</span>
          </div>
        </div>

        <div className="companion-scene">
          <span className="scene-orbit scene-orbit-one" aria-hidden="true" />
          <span className="scene-orbit scene-orbit-two" aria-hidden="true" />
          <div className="scene-topline"><span><span className="presence-dot" /> 小猪的桌面一角</span><span className="scene-dots" aria-hidden="true">•••</span></div>
          <div className="scene-note"><span className="scene-note-icon" aria-hidden="true">☀</span><div>今天也不用太着急<span>一点点来，就很好。</span></div></div>
          <div className="pet-greeting" role="status">{greetings[greetingIndex]}</div>
          <button
            type="button"
            className={`hero-pet ${hasPetted ? 'hero-pet-happy' : ''}`}
            aria-label="摸摸小猪，看看它的回应"
            onClick={() => { setHasPetted(true); setGreetingIndex((index) => (index + 1) % greetings.length) }}
          >
            <img src={hasPetted ? pigHappy : pigIdle} alt="在桌面等你的小猪" width={420} height={370} decoding="async" />
            <span className="pet-touch-hint">摸摸我 <span aria-hidden="true">♡</span></span>
          </button>
          <div className="scene-ground" aria-hidden="true" />
          <div className="scene-bottomline"><span>一点陪伴，刚刚好。</span><span>互动预览</span></div>
        </div>
      </section>

      <section className="companion-values" aria-label="陪伴的方式">
        <span><span aria-hidden="true">✦</span> 待在你的桌面</span>
        <span><span aria-hidden="true">♡</span> 随着相处慢慢熟悉</span>
        <span><span aria-hidden="true">☾</span> 想安静时，也懂你</span>
      </section>

      <section id="moments" className="moments-section" aria-labelledby="moments-title">
        <div className="section-intro"><div><span className="home-eyebrow">LITTLE MOMENTS, TOGETHER</span><h2 id="moments-title">让那些小瞬间，<br />有个小小的回应。</h2></div><p>不用安排一场盛大的冒险。<br />你们的故事，就从今天的桌面开始。</p></div>
        <div className="moments-grid">
          {moments.map((moment) => (
            <article key={moment.number} className={`moment-card moment-${moment.tone}`}>
              <div className="moment-card-top"><span className="moment-icon" aria-hidden="true">{moment.icon}</span><span>{moment.number}</span></div>
              <h3>{moment.title}</h3><p>{moment.description}</p><div className="moment-note">{moment.note}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="quiet-section" aria-labelledby="quiet-title">
        <div className="quiet-illustration" aria-hidden="true"><span className="quiet-moon">☾</span><span className="quiet-star">✧</span><img src={pigIdle} alt="" width={240} height={210} loading="lazy" decoding="async" /><span className="quiet-label">陪伴，也可以很安静</span></div>
        <div className="quiet-copy"><span className="home-eyebrow">YOUR DAY, YOUR PACE</span><h2 id="quiet-title">在旁边，<br />也给你留出空间。</h2><p>专心做事时，让它安静待在角落。你可以在桌面客户端静音、调低主动陪伴频率，或关闭主动陪伴。什么时候回来，都可以从一次摸摸重新开始。</p><Link to="/download" className="companion-text-link">到桌面客户端设置陪伴方式 <span aria-hidden="true">→</span></Link></div>
      </section>

      <section className="home-faq" aria-labelledby="faq-title">
        <div><span className="home-eyebrow">BEFORE WE MEET</span><h2 id="faq-title">见面前，<br />你可能想知道。</h2></div>
        <div className="faq-items">
          <details><summary>怎样把小猪带到桌面？<span aria-hidden="true">+</span></summary><p>先创建账号，再到下载页获取 Windows x64 安装包。安装并登录后，在桌宠偏好中选择「小猪」，就可以开始相处。下载页会显示当前真实的发布状态。</p></details>
          <details><summary>可以在网页或手机上养它吗？<span aria-hidden="true">+</span></summary><p>目前的桌宠体验在 Windows 客户端中。这个网站用于了解伙伴、注册账号、下载安装包和管理账户；首页的小猪只是互动预览。</p></details>
          <details><summary>几天没来，它会和我变生疏吗？<span aria-hidden="true">+</span></summary><p>不会。亲密度不会因为你忙几天而倒退。不用为打卡赶回来，按照自己的节奏相处就好。</p></details>
          <details><summary>换电脑以后，相处记录还在吗？<span aria-hidden="true">+</span></summary><p>登录同一账号后，桌宠偏好、亲密度和装扮会与云端同步。窗口位置、静音和开机启动等本机设置则保留在各自电脑上。</p></details>
        </div>
      </section>

      <section className="home-invitation" aria-labelledby="invitation-title"><span className="home-eyebrow">A LITTLE COMPANY GOES A LONG WAY</span><h2 id="invitation-title">给桌面一个角落，<br />给日常一点陪伴。</h2><Link to="/download" className="companion-button companion-button-primary">去见见小猪 <span aria-hidden="true">↗</span></Link><p>Windows x64 · 从一次见面开始</p></section>
    </div>
  )
}
