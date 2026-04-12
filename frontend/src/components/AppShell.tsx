import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { useAuthStore } from '../stores'

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    'rounded-full px-4 py-2 text-sm transition-colors',
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white/70',
  ].join(' ')

export default function AppShell() {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(243,244,246,0.95),_rgba(255,255,255,0.88)_40%,_rgba(224,242,254,0.75)_100%)]">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <button type="button" onClick={() => navigate('/')} className="text-left">
            <div className="font-mono text-xl font-semibold text-slate-950">Detachym</div>
            <div className="text-xs uppercase tracking-[0.25em] text-slate-500">Desktop Pet Cloud</div>
          </button>

          <nav className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50/90 p-1">
            <NavLink to="/" className={navClass} end>
              首页
            </NavLink>
            <NavLink to="/download" className={navClass}>
              下载
            </NavLink>
            {user && (
              <NavLink to="/account" className={navClass}>
                用户中心
              </NavLink>
            )}
            {user?.is_superuser && (
              <NavLink to="/admin" className={navClass}>
                管理后台
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <>
                <div className="hidden text-right sm:block">
                  <div className="text-sm font-medium text-slate-900">{user.username}</div>
                  <div className="text-xs text-slate-500">{user.email}</div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/account')}
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm text-white transition hover:bg-slate-700"
                >
                  控制台
                </button>
                <button
                  type="button"
                  onClick={() => {
                    logout()
                    navigate('/login')
                  }}
                  className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  退出
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate('/login')}
                  className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  登录
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/register')}
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm text-white transition hover:bg-slate-700"
                >
                  注册
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  )
}
