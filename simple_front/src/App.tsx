import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import Login from './pages/Login.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Chat from './pages/Chat.tsx'
import Settings from './pages/Settings.tsx'
import KnowledgeBase from './pages/KnowledgeBase.tsx'
import CronJobs from './pages/CronJobs.tsx'
import { isLoggedIn } from './lib/api.ts'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="dashboard/knowledge" element={<Navigate to="/knowledge" replace />} />
        <Route path="knowledge" element={<KnowledgeBase />} />
        <Route path="cron" element={<CronJobs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="chat" element={<Chat />} />
      </Route>
    </Routes>
  )
}
