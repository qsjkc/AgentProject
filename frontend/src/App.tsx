import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import AppShell from './components/AppShell'
import RootErrorBoundary from './components/RootErrorBoundary'
import { Account, Admin, Download, Home, Login, Register } from './pages'
import { useAuthStore } from './stores'

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, user, loading } = useAuthStore()

  if (!token) {
    return <Navigate to="/login" replace />
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="surface-panel rounded-[2rem] p-8 text-center reveal-rise">
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
    return <Navigate to="/login" replace />
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
  const { token, fetchUser } = useAuthStore()

  useEffect(() => {
    if (token) {
      void fetchUser()
    }
  }, [token, fetchUser])

  return (
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
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <RootErrorBoundary>
        <AuthBootstrap />
      </RootErrorBoundary>
    </BrowserRouter>
  )
}
