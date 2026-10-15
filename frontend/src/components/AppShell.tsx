import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useAuthStore } from '../stores'

const navClass = ({ isActive }: { isActive: boolean }) => `portal-nav-link ${isActive ? 'is-active' : ''}`

export default function AppShell() {
  const navigate = useNavigate()
  const { pathname, hash } = useLocation()
  const { user, logout } = useAuthStore()

  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [pathname, hash])

  return (
    <div className="portal-shell">
      <a href="#main-content" className="skip-to-content">跳转到正文</a>
      <header className="portal-header">
        <div className="portal-header-inner">
          <Link to="/" className="portal-brand" aria-label="Detachym 首页"><span className="brand-symbol" aria-hidden="true">d.</span><span>Detachym<small>日常里的小小陪伴</small></span></Link>
          <nav className="portal-nav" aria-label="主导航">
            <NavLink to="/" className={navClass} end>首页</NavLink>
            <NavLink to="/download" className={navClass}>下载桌宠</NavLink>
            {user && <NavLink to="/account" className={navClass}>用户中心</NavLink>}
            {user?.is_superuser && <NavLink to="/admin" className={navClass}>管理后台</NavLink>}
          </nav>
          <div className="portal-account-actions">
            {user ? <>
              <Link to="/account" className="portal-user-name" title={user.username}>{user.username}</Link>
              <button type="button" onClick={() => { logout(); navigate('/login') }} className="portal-login">退出</button>
            </> : <>
              <Link to="/login" className="portal-login">登录</Link>
              <Link to="/register" className="portal-register">加入陪伴 <span aria-hidden="true">↗</span></Link>
            </>}
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="portal-main"><Outlet /></main>
      <footer className="portal-footer"><Link to="/" className="portal-footer-brand">Detachym<span>陪你，把普通的一天过好。</span></Link><div><Link to="/download">下载桌宠</Link><Link to={user ? '/account' : '/login'}>账户管理</Link><span>为 Windows 桌面上的日常而做</span></div></footer>
    </div>
  )
}
