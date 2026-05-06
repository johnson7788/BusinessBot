import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowRight, Bot, Loader2, LockKeyhole, Mail, User, Workflow } from 'lucide-react'
import { login, register } from '../lib/api.ts'
import ClearableInput from '../components/ui/ClearableInput.tsx'

export default function Login() {
  const navigate = useNavigate()
  const loginShellRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    if (mode === 'register' && !email.trim()) return
    
    setError('')
    setLoading(true)

    try {
      if (mode === 'login') {
        await login(username.trim(), password)
      } else {
        await register(username.trim(), email.trim(), password)
      }
      navigate('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    loginShellRef.current?.style.setProperty('--login-pointer-x', `${x}%`)
    loginShellRef.current?.style.setProperty('--login-pointer-y', `${y}%`)
  }

  const resetPointerPosition = () => {
    loginShellRef.current?.style.setProperty('--login-pointer-x', '50%')
    loginShellRef.current?.style.setProperty('--login-pointer-y', '42%')
  }

  return (
    <div
      ref={loginShellRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointerPosition}
      className="login-shell relative min-h-screen overflow-hidden bg-[#f7fbff] text-light-text"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,#ffffff_0%,#eef9fb_42%,#f8fbff_100%)]" />
      <div className="login-bg-grid pointer-events-none absolute inset-0 opacity-[0.34]" />
      <div className="login-bg-flow pointer-events-none absolute -inset-x-32 -inset-y-24 opacity-80 blur-3xl" />
      <div className="login-pointer-light pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent-blue/40 to-transparent" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/70 bg-white/80 text-accent-blue shadow-sm backdrop-blur">
              <Bot size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-normal text-light-text">OpenClaw Lite</div>
              <div className="text-xs text-light-text-secondary">Agent workspace</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/70 bg-white/60 px-3 py-1.5 text-xs text-light-text-secondary shadow-sm backdrop-blur sm:flex">
            <Workflow size={14} />
            多 Agent 对话入口
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center py-12">
          <section className="w-full max-w-[420px]">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-lg shadow-cyan-900/10">
                <Bot size={22} />
              </div>
              <h1 className="text-3xl font-medium tracking-normal text-light-text">
                {mode === 'login' ? '欢迎回来' : '创建 OpenClaw 账号'}
              </h1>
              <p className="mt-3 text-sm leading-6 text-light-text-secondary">
                {mode === 'login'
                  ? '登录后继续你的 Agent 会话和默认对话。'
                  : '创建账号后即可开始组织你的 Agent 工作流。'}
              </p>
            </div>

            <div className="rounded-[24px] border border-white/80 bg-white/82 p-5 shadow-xl shadow-cyan-950/10 backdrop-blur-xl">
              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-2xl border border-accent-red/20 bg-accent-red/5 px-3 py-2.5 text-sm text-accent-red">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="auth-username" className="mb-1.5 block text-xs font-medium text-light-text-secondary">
                    用户名
                  </label>
                  <div className="flex items-center gap-2 rounded-2xl border border-light-border bg-white px-3 transition-colors focus-within:border-accent-blue">
                    <User size={16} className="shrink-0 text-light-text-secondary" />
                    <ClearableInput
                      id="auth-username"
                      type="text"
                      value={username}
                      onValueChange={setUsername}
                      required
                      autoComplete="username"
                      className="min-h-11 w-full bg-transparent text-sm text-light-text outline-none placeholder:text-slate-400"
                      placeholder="输入用户名"
                      clearLabel="清空用户名"
                    />
                  </div>
                </div>

                {mode === 'register' && (
                  <div className="animate-fade-in">
                    <label htmlFor="auth-email" className="mb-1.5 block text-xs font-medium text-light-text-secondary">
                      邮箱
                    </label>
                    <div className="flex items-center gap-2 rounded-2xl border border-light-border bg-white px-3 transition-colors focus-within:border-accent-blue">
                      <Mail size={16} className="shrink-0 text-light-text-secondary" />
                      <ClearableInput
                        id="auth-email"
                        type="email"
                        value={email}
                        onValueChange={setEmail}
                        required
                        autoComplete="email"
                        className="min-h-11 w-full bg-transparent text-sm text-light-text outline-none placeholder:text-slate-400"
                        placeholder="输入邮箱"
                        clearLabel="清空邮箱"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="auth-password" className="mb-1.5 block text-xs font-medium text-light-text-secondary">
                    密码
                  </label>
                  <div className="flex items-center gap-2 rounded-2xl border border-light-border bg-white px-3 transition-colors focus-within:border-accent-blue">
                    <LockKeyhole size={16} className="shrink-0 text-light-text-secondary" />
                    <ClearableInput
                      id="auth-password"
                      type="password"
                      value={password}
                      onValueChange={setPassword}
                      required
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      className="min-h-11 w-full bg-transparent text-sm text-light-text outline-none placeholder:text-slate-400"
                      placeholder="输入密码"
                      clearLabel="清空密码"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !username.trim() || !password || (mode === 'register' && !email.trim())}
                  className="mt-1 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {loading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      {mode === 'login' ? '登录中' : '注册中'}
                    </>
                  ) : (
                    <>
                      {mode === 'login' ? '登录' : '注册'}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-5 border-t border-light-border pt-4 text-center text-sm text-light-text-secondary">
                {mode === 'login' ? (
                  <>
                    还没有账号？{' '}
                    <button
                      type="button"
                      onClick={() => { setMode('register'); setError('') }}
                      className="cursor-pointer font-medium text-accent-blue transition-colors hover:text-cyan-700"
                    >
                      创建账号
                    </button>
                  </>
                ) : (
                  <>
                    已有账号？{' '}
                    <button
                      type="button"
                      onClick={() => { setMode('login'); setError('') }}
                      className="cursor-pointer font-medium text-accent-blue transition-colors hover:text-cyan-700"
                    >
                      返回登录
                    </button>
                  </>
                )}
              </div>
            </div>

            <p className="mt-5 text-center text-xs leading-5 text-light-text-secondary">
              登录即表示你将进入本地 OpenClaw ToC 前端体验。
            </p>
          </section>
        </main>
      </div>
    </div>
  )
}
