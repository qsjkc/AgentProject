import type { ReactNode } from 'react'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import AppShell from './components/AppShell'
import RootErrorBoundary from './components/RootErrorBoundary'
import { AUTH_EXPIRED_EVENT } from './lib/auth'
import Home from './pages/Home'
import { useAuthStore } from './stores'

const Account = lazy(() => import('./pages/Account'))
const Admin = lazy(() => import('./pages/Admin'))
const Download = lazy(() => import('./pages/Download'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const VoiceDemoPage = lazy(() => import('./pages/VoiceDemoPage'))

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, user, loading, error, fetchUser } = useAuthStore()
  const location = useLocation()

  if (!token) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search + location.hash }} replace />
  }

  if (loading && !user) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div role="status" className="surface-panel rounded-[2rem] p-8 text-center reveal-rise">
          <div className="eyebrow">Detachym</div>
          <h1 className="section-title mt-4">正在同步账户信息</h1>
          <p className="body-copy mx-auto mt-4 max-w-xl text-sm">
            页面正在确认你的登录状态与桌宠偏好，请稍候片刻。
          </p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="surface-panel mx-auto max-w-3xl rounded-[2rem] p-8 text-center">
        <h1 className="section-title">暂时无法同步账户信息</h1>
        <p role="alert" className="body-copy mt-4">{error}</p>
        <button type="button" onClick={() => void fetchUser()} className="companion-button companion-button-primary mt-6">重新同步</button>
      </div>
    )
  }

  return children
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuthStore()

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  return children
}

function AuthBootstrap() {
  const { token, fetchUser, logout, setToken } = useAuthStore()
  const location = useLocation()

  useEffect(() => {
    const syncSession = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'token' || event.key === null)) {
        setToken(localStorage.getItem('token'))
      }
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, logout)
    window.addEventListener('storage', syncSession)
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, logout)
      window.removeEventListener('storage', syncSession)
    }
  }, [logout, setToken])

  useEffect(() => {
    if (token) {
      void fetchUser()
    }
  }, [token, fetchUser])

  return (
    <RootErrorBoundary resetKey={location.key}>
    <Suspense fallback={<div role="status" className="px-6 py-16 text-center text-slate-600">正在加载页面...</div>}>
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/download" element={<Download />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <Account />
            </RequireAuth>
          }
        />
        <Route
          path="/voice-demo"
          element={
            <RequireAuth>
              <VoiceDemoPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireAdmin>
                <Admin />
              </RequireAdmin>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
    </RootErrorBoundary>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthBootstrap />
    </BrowserRouter>
  )
}
