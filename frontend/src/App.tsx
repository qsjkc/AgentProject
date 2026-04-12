import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import AppShell from './components/AppShell'
import { Account, Admin, Download, Home, Login, Register } from './pages'
import { useAuthStore } from './stores'

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, user, loading } = useAuthStore()

  if (!token) {
    return <Navigate to="/login" replace />
  }

  if (loading && !user) {
    return <div className="py-24 text-center text-sm text-slate-500">正在加载账户信息...</div>
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
      <AuthBootstrap />
    </BrowserRouter>
  )
}
