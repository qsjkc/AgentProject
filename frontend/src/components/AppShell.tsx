import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { useAuthStore } from '../stores'

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    'rounded-full px-4 py-2 text-sm transition-all duration-200',
    isActive
      ? 'bg-stone-950 text-stone-50 shadow-[0_14px_32px_rgba(24,19,15,0.18)]'
      : 'text-stone-600 hover:bg-white/70 hover:text-stone-950',
  ].join(' ')

export default function AppShell() {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()

  return (
    <div className="app-backdrop min-h-screen">
      <header className="sticky top-0 z-30 px-4 pt-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1320px]">
          <div className="surface-panel rounded-full px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <button type="button" onClick={() => navigate('/')} className="flex items-center gap-4 text-left">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-300/40 bg-amber-200/20 text-xs font-semibold tracking-[0.32em] text-amber-800">
                  DT
                </div>
                <div>
                  <div className="font-display text-3xl leading-none text-stone-950">Detachym</div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.36em] text-stone-500">
                    Desktop Pet Cloud
                  </div>
                </div>
              </button>

              <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                <nav className="flex flex-wrap items-center gap-2 rounded-full border border-stone-200/80 bg-white/55 p-1">
                  <NavLink to="/" className={navClass} end>
                    首页
                  </NavLink>
                  <NavLink to="/download" className={navClass}>
                    下载
                  </NavLink>
                  {user && (
                    <NavLink to="/account" className={navClass}>
                      我的账户
                    </NavLink>
                  )}
                  {user?.is_superuser && (
                    <NavLink to="/admin" className={navClass}>
                      管理后台
                    </NavLink>
                  )}
                </nav>

                <div className="flex flex-wrap items-center gap-3">
                  {user ? (
                    <>
                      <div className="hidden text-right lg:block">
                        <div className="text-sm font-medium text-stone-950">{user.username}</div>
                        <div className="text-xs text-stone-500">{user.email}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate('/account')}
                        className="primary-button text-sm font-medium"
                      >
                        进入控制台
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          logout()
                          navigate('/login')
                        }}
                        className="secondary-button text-sm"
                      >
                        退出登录
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => navigate('/login')}
                        className="secondary-button text-sm"
                      >
                        登录
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate('/register')}
                        className="primary-button text-sm font-medium"
                      >
                        创建账户
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] px-4 pb-14 pt-10 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
