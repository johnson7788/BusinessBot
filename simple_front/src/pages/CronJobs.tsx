import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import ClearableInput from '../components/ui/ClearableInput.tsx'
import ClearableTextarea from '../components/ui/ClearableTextarea.tsx'
import IconButton from '../components/ui/IconButton.tsx'
import Popconfirm from '../components/ui/Popconfirm.tsx'
import {
  createCronJob,
  deleteCronJob,
  listCronJobs,
  runCronJob,
  toggleCronJob,
  type CronJob,
} from '../lib/api.ts'

type ScheduleType = 'every' | 'cron' | 'once'

const scheduleOptions: Array<{ value: ScheduleType; label: string }> = [
  { value: 'every', label: '固定间隔' },
  { value: 'cron', label: 'Cron' },
  { value: 'once', label: '单次' },
]

function formatTime(ms: number | null): string {
  if (!ms) return '-'
  const date = new Date(ms)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function formatEveryMs(ms: number | null): string {
  if (!ms || ms <= 0) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `每 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `每 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  if (hours < 24) {
    return remainMinutes > 0 ? `每 ${hours} 小时 ${remainMinutes} 分钟` : `每 ${hours} 小时`
  }
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `每 ${days} 天 ${remainHours} 小时` : `每 ${days} 天`
}

function getScheduleText(job: CronJob): string {
  return job.schedule_display || job.schedule_expr || formatEveryMs(job.schedule_every_ms)
}

function getJobTitle(job: CronJob): string {
  return job.name?.trim() || job.id
}

function AlertMessage({
  message,
  tone = 'danger',
  onClose,
}: {
  message: string
  tone?: 'danger' | 'success'
  onClose?: () => void
}) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle
  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
        tone === 'success' ? 'bg-accent-blue/5 text-accent-blue' : 'bg-accent-red/5 text-accent-red'
      }`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onClose && (
        <IconButton label="关闭提示" size="sm" surface="plain" onClick={onClose}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

function StatCardSkeleton() {
  return (
    <div className="rounded-xl border border-light-border bg-light-card px-4 py-3" aria-hidden="true">
      <div className="skeleton-shimmer h-3 w-16 rounded-full" />
      <div className="skeleton-shimmer mt-3 h-7 w-10 rounded-lg" />
    </div>
  )
}

function CronJobsSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-light-border bg-light-card" aria-label="正在加载定时任务">
      <div className="hidden grid-cols-[minmax(220px,1fr)_180px_150px_150px_132px] gap-3 border-b border-light-border bg-light-card-hover px-4 py-3 lg:grid">
        {Array.from({ length: 5 }).map((_, index) => (
          <span key={index} className={`skeleton-shimmer h-3 rounded-full ${index === 0 ? 'w-12' : 'w-16'} ${index === 4 ? 'ml-auto' : ''}`} />
        ))}
      </div>
      <div className="divide-y divide-light-border">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(220px,1fr)_180px_150px_150px_132px] lg:items-center"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="skeleton-shimmer h-4 w-44 max-w-[62%] rounded-full" />
                <span className="skeleton-shimmer h-5 w-11 rounded-full" />
              </div>
              <div className="skeleton-shimmer mt-3 h-3 w-full max-w-md rounded-full" />
            </div>
            <div className="flex items-center gap-2">
              <span className="skeleton-shimmer h-4 w-4 shrink-0 rounded-md" />
              <span className="skeleton-shimmer h-3 w-28 rounded-full" />
            </div>
            <div className="skeleton-shimmer h-3 w-20 rounded-full" />
            <div className="skeleton-shimmer h-3 w-20 rounded-full" />
            <div className="flex items-center justify-end gap-1">
              <span className="skeleton-shimmer h-8 w-8 rounded-lg" />
              <span className="skeleton-shimmer h-8 w-8 rounded-lg" />
              <span className="skeleton-shimmer h-8 w-8 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CreateCronPanel({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (job: CronJob) => void
}) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('every')
  const [everySeconds, setEverySeconds] = useState('3600')
  const [cronExpr, setCronExpr] = useState('')
  const [atIso, setAtIso] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
  }, [open])

  const everyPreview = useMemo(
    () => formatEveryMs((Number.parseInt(everySeconds, 10) || 0) * 1000),
    [everySeconds],
  )

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    const trimmedMessage = message.trim()
    if (!trimmedName) {
      setError('请输入任务名称')
      return
    }
    if (!trimmedMessage) {
      setError('请输入任务消息')
      return
    }

    const params: Parameters<typeof createCronJob>[0] = {
      name: trimmedName,
      message: trimmedMessage,
    }

    if (scheduleType === 'every') {
      const seconds = Number.parseInt(everySeconds, 10)
      if (!Number.isFinite(seconds) || seconds < 1) {
        setError('间隔秒数必须大于 0')
        return
      }
      params.every_seconds = seconds
    }

    if (scheduleType === 'cron') {
      const expr = cronExpr.trim()
      if (!expr) {
        setError('请输入 Cron 表达式')
        return
      }
      params.cron_expr = expr
    }

    if (scheduleType === 'once') {
      if (!atIso.trim()) {
        setError('请选择执行时间')
        return
      }
      const date = new Date(atIso)
      if (Number.isNaN(date.getTime())) {
        setError('执行时间格式不正确')
        return
      }
      params.at_iso = date.toISOString()
    }

    setSaving(true)
    setError('')
    try {
      const job = await createCronJob(params)
      onCreated(job)
      setName('')
      setMessage('')
      setScheduleType('every')
      setEverySeconds('3600')
      setCronExpr('')
      setAtIso('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30 backdrop-blur-[1px]">
      <button type="button" aria-label="关闭新建任务面板" className="min-w-0 flex-1" onClick={onClose} />
      <aside className="agent-panel flex h-full w-full max-w-xl flex-col border-l border-light-border bg-light-card shadow-2xl shadow-slate-950/15">
        <header className="flex items-center justify-between border-b border-light-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-light-text">新建定时任务</h2>
            <p className="mt-1 text-xs text-light-text-secondary">定时把消息发送给 Agent 执行</p>
          </div>
          <IconButton label="关闭面板" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-5">
            {error && <AlertMessage message={error} />}

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-light-text-secondary">任务名称</span>
              <ClearableInput
                value={name}
                onValueChange={setName}
                placeholder="例：每日报告"
                clearLabel="清空任务名称"
                className="h-10 rounded-xl border border-light-border bg-light-card-hover px-3 text-sm text-light-text placeholder:text-light-text-secondary focus:border-accent-blue"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-light-text-secondary">任务消息</span>
              <ClearableTextarea
                value={message}
                onValueChange={setMessage}
                rows={4}
                placeholder="Agent 将收到的消息内容..."
                clearLabel="清空任务消息"
                className="resize-none rounded-xl border border-light-border bg-light-card-hover px-3 py-2 text-sm leading-6 text-light-text placeholder:text-light-text-secondary focus:border-accent-blue"
              />
              <span className="mt-1 block text-xs text-light-text-secondary">
                定时触发时，此消息将作为用户输入发送给 Agent。
              </span>
            </label>

            <div>
              <div className="mb-2 text-xs font-medium text-light-text-secondary">调度方式</div>
              <div className="grid grid-cols-3 gap-2 rounded-xl bg-light-card-hover p-1">
                {scheduleOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setScheduleType(option.value)}
                    className={`cursor-pointer rounded-lg px-3 py-2 text-sm transition-colors ${
                      scheduleType === option.value
                        ? 'bg-light-card text-light-text shadow-sm'
                        : 'text-light-text-secondary hover:text-light-text'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {scheduleType === 'every' && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-light-text-secondary">间隔秒数</span>
                <ClearableInput
                  type="number"
                  min={1}
                  value={everySeconds}
                  onValueChange={setEverySeconds}
                  placeholder="3600"
                  clearLabel="清空间隔"
                  className="h-10 rounded-xl border border-light-border bg-light-card-hover px-3 text-sm text-light-text placeholder:text-light-text-secondary focus:border-accent-blue"
                />
                <span className="mt-1 block text-xs text-light-text-secondary">{everyPreview}</span>
              </label>
            )}

            {scheduleType === 'cron' && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-light-text-secondary">Cron 表达式</span>
                <ClearableInput
                  value={cronExpr}
                  onValueChange={setCronExpr}
                  placeholder="0 9 * * *"
                  clearLabel="清空 Cron 表达式"
                  className="h-10 rounded-xl border border-light-border bg-light-card-hover px-3 font-mono text-sm text-light-text placeholder:text-light-text-secondary focus:border-accent-blue"
                />
                <span className="mt-1 block text-xs text-light-text-secondary">
                  格式：分 时 日 月 周，例如 0 9 * * * 表示每天 9:00。
                </span>
              </label>
            )}

            {scheduleType === 'once' && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-light-text-secondary">执行时间</span>
                <ClearableInput
                  type="datetime-local"
                  value={atIso}
                  onValueChange={setAtIso}
                  clearLabel="清空执行时间"
                  className="h-10 rounded-xl border border-light-border bg-light-card-hover px-3 text-sm text-light-text focus:border-accent-blue"
                />
              </label>
            )}
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-light-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-light-border px-4 py-2 text-sm text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            创建
          </button>
        </footer>
      </aside>
    </div>
  )
}

export default function CronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [runningId, setRunningId] = useState('')
  const [togglingId, setTogglingId] = useState('')
  const [deletingId, setDeletingId] = useState('')

  const loadJobs = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true)
    setError('')
    try {
      const result = await listCronJobs(true)
      setJobs(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取定时任务失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadJobs(true)
  }, [loadJobs])

  const enabledCount = useMemo(() => jobs.filter(job => job.enabled).length, [jobs])

  const handleRefresh = () => {
    setRefreshing(true)
    void loadJobs()
  }

  const handleToggle = async (job: CronJob) => {
    setTogglingId(job.id)
    setError('')
    setNotice('')
    try {
      const updated = await toggleCronJob(job.id, !job.enabled)
      setJobs(current => current.map(item => (item.id === job.id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换状态失败')
    } finally {
      setTogglingId('')
    }
  }

  const handleRun = async (job: CronJob) => {
    setRunningId(job.id)
    setError('')
    setNotice('')
    try {
      await runCronJob(job.id)
      setNotice(`已触发“${getJobTitle(job)}”`)
      await loadJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : '执行失败')
    } finally {
      setRunningId('')
    }
  }

  const handleDelete = async (job: CronJob) => {
    setDeletingId(job.id)
    setError('')
    setNotice('')
    try {
      await deleteCronJob(job.id)
      setJobs(current => current.filter(item => item.id !== job.id))
      setNotice(`已删除“${getJobTitle(job)}”`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingId('')
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-light-bg">
      <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-5 py-8 sm:px-8 lg:px-12">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-normal text-light-text">定时任务</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-light-text-secondary">
              管理 Agent 的自动执行计划，适合日报、提醒和周期性检查。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <IconButton label="刷新定时任务" onClick={handleRefresh} disabled={refreshing} tone="primary">
              <RefreshCw size={17} className={refreshing ? 'animate-spin' : ''} />
            </IconButton>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-700"
            >
              <Plus size={16} />
              新建任务
            </button>
          </div>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          {loading ? (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          ) : (
            <>
              <div className="rounded-xl border border-light-border bg-light-card px-4 py-3">
                <div className="text-xs text-light-text-secondary">全部任务</div>
                <div className="mt-1 text-2xl font-semibold text-light-text">{jobs.length}</div>
              </div>
              <div className="rounded-xl border border-light-border bg-light-card px-4 py-3">
                <div className="text-xs text-light-text-secondary">运行中</div>
                <div className="mt-1 text-2xl font-semibold text-light-text">{enabledCount}</div>
              </div>
              <div className="rounded-xl border border-light-border bg-light-card px-4 py-3">
                <div className="text-xs text-light-text-secondary">异常任务</div>
                <div className="mt-1 text-2xl font-semibold text-light-text">
                  {jobs.filter(job => job.last_status === 'error').length}
                </div>
              </div>
            </>
          )}
        </section>

        <div className="mt-5 space-y-2">
          {error && <AlertMessage message={error} onClose={() => setError('')} />}
          {notice && <AlertMessage message={notice} tone="success" onClose={() => setNotice('')} />}
        </div>

        <section className="mt-5 min-h-0 flex-1">
          {loading ? (
            <CronJobsSkeleton />
          ) : jobs.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-light-border bg-light-card px-5 py-12 text-center">
              <Clock size={40} className="text-accent-blue" />
              <div className="mt-4 text-sm font-medium text-light-text">暂无定时任务</div>
              <div className="mt-1 max-w-sm text-sm leading-6 text-light-text-secondary">
                创建一个固定间隔、Cron 或单次执行的任务，让 Agent 在指定时间自动处理消息。
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="mt-5 flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-700"
              >
                <Plus size={16} />
                创建第一个任务
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-light-border bg-light-card">
              <div className="hidden grid-cols-[minmax(220px,1fr)_180px_150px_150px_132px] gap-3 border-b border-light-border bg-light-card-hover px-4 py-3 text-xs font-medium text-light-text-secondary lg:grid">
                <span>任务</span>
                <span>调度</span>
                <span>上次执行</span>
                <span>下次执行</span>
                <span className="text-right">操作</span>
              </div>
              <div className="divide-y divide-light-border">
                {jobs.map(job => (
                  <div
                    key={job.id}
                    className="grid gap-3 px-4 py-4 transition-colors hover:bg-light-card-hover/55 lg:grid-cols-[minmax(220px,1fr)_180px_150px_150px_132px] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            job.enabled ? 'text-light-text' : 'text-light-text-secondary line-through'
                          }`}
                          title={getJobTitle(job)}
                        >
                          {getJobTitle(job)}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            job.enabled ? 'bg-accent-green/10 text-green-700' : 'bg-slate-100 text-light-text-secondary'
                          }`}
                        >
                          {job.enabled ? '启用' : '停用'}
                        </span>
                        {job.last_status === 'error' && (
                          <span className="shrink-0 rounded-full bg-accent-red/10 px-2 py-0.5 text-[11px] font-medium text-accent-red">
                            异常
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-light-text-secondary" title={job.message}>
                        {job.message}
                      </p>
                      {job.last_error && (
                        <p className="mt-1 truncate text-xs text-accent-red" title={job.last_error}>
                          {job.last_error}
                        </p>
                      )}
                    </div>

                    <div className="flex min-w-0 items-center gap-2 text-xs text-light-text-secondary">
                      <CalendarClock size={15} className="shrink-0 text-accent-blue" />
                      <span className="truncate" title={getScheduleText(job)}>{getScheduleText(job)}</span>
                    </div>
                    <div className="text-xs text-light-text-secondary">
                      <span className="lg:hidden">上次：</span>
                      {formatTime(job.last_run_at_ms)}
                    </div>
                    <div className="text-xs text-light-text-secondary">
                      <span className="lg:hidden">下次：</span>
                      {formatTime(job.next_run_at_ms)}
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label={job.enabled ? '停用任务' : '启用任务'}
                        onClick={() => void handleToggle(job)}
                        disabled={togglingId === job.id}
                      >
                        {togglingId === job.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : job.enabled ? (
                          <Pause size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                      </IconButton>
                      <IconButton
                        label="立即执行"
                        tone="primary"
                        onClick={() => void handleRun(job)}
                        disabled={runningId === job.id || !job.enabled}
                      >
                        {runningId === job.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                      </IconButton>
                      <Popconfirm
                        title="删除定时任务？"
                        description={`删除“${getJobTitle(job)}”后不可恢复。`}
                        confirmText="删除"
                        danger
                        onConfirm={() => handleDelete(job)}
                      >
                        <IconButton label="删除任务" tone="danger" disabled={deletingId === job.id}>
                          {deletingId === job.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </IconButton>
                      </Popconfirm>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <CreateCronPanel
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={job => {
          setJobs(current => [...current, job])
          setNotice(`已创建“${getJobTitle(job)}”`)
          setCreateOpen(false)
        }}
      />
    </div>
  )
}
