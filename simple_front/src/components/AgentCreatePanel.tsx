import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Bot, Check, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import ClearableInput from './ui/ClearableInput.tsx'
import ClearableTextarea from './ui/ClearableTextarea.tsx'
import IconButton from './ui/IconButton.tsx'
import { createAgent, generateAgentIcon } from '../lib/api.ts'

type AgentPanelMode = 'create' | 'edit' | 'view'

type AgentCreatePanelProps = {
  open: boolean
  onClose: () => void
  mode?: AgentPanelMode
  initialValues?: {
    agentId: string
    displayName: string
    description?: string
    avatar?: string
  }
  onCreated?: (agentId: string, displayName: string) => void | Promise<void>
  onSaved?: (input: {
    agentId: string
    displayName: string
    description: string
    avatar: string
  }) => void | Promise<void>
}

function sanitizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export default function AgentCreatePanel({
  open,
  onClose,
  mode = 'create',
  initialValues,
  onCreated,
  onSaved,
}: AgentCreatePanelProps) {
  const [displayName, setDisplayName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState('')
  const [generatedIconId, setGeneratedIconId] = useState('')
  const [saving, setSaving] = useState(false)
  const [generatingIcon, setGeneratingIcon] = useState(false)
  const [error, setError] = useState('')

  const readOnly = mode === 'view'
  const editingExisting = mode !== 'create'
  const normalizedAgentId = useMemo(() => sanitizeAgentId(agentId), [agentId])
  const canSubmit = Boolean(!readOnly && displayName.trim() && (editingExisting ? normalizedAgentId : true) && !saving)

  useEffect(() => {
    if (!open) return
    setError('')
    if (editingExisting && initialValues) {
      setDisplayName(initialValues.displayName)
      setAgentId(initialValues.agentId)
      setDescription(initialValues.description || '')
      setAvatar(initialValues.avatar || '')
      setGeneratedIconId('')
      return
    }
    if (mode === 'create') {
      setDisplayName('')
      setAgentId('')
      setDescription('')
      setAvatar('')
      setGeneratedIconId('')
    }
  }, [editingExisting, initialValues, mode, open])

  useEffect(() => {
    if (!open || readOnly || avatar || !displayName.trim()) return
    const timer = window.setTimeout(() => {
      void refreshIcon()
    }, 450)
    return () => window.clearTimeout(timer)
  }, [avatar, description, displayName, open, readOnly])

  const refreshIcon = async () => {
    if (readOnly) return
    setGeneratingIcon(true)
    setError('')
    try {
      const icon = await generateAgentIcon(
        displayName.trim(),
        description.trim(),
        `${Date.now()}-${Math.random()}`,
        generatedIconId,
      )
      setAvatar(icon.dataUrl)
      setGeneratedIconId(icon.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成图标失败')
    } finally {
      setGeneratingIcon(false)
    }
  }

  if (!open) return null

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    setSaving(true)
    setError('')
    try {
      const nextDisplayName = displayName.trim()
      if (mode === 'edit') {
        await onSaved?.({
          agentId: normalizedAgentId,
          displayName: nextDisplayName,
          description: description.trim(),
          avatar,
        })
        onClose()
        return
      }

      const generated = avatar ? null : await generateAgentIcon(nextDisplayName, description.trim(), '', generatedIconId)
      const nextAvatar = avatar || generated?.dataUrl || ''
      if (generated?.id) setGeneratedIconId(generated.id)
      const result = await createAgent({
          agentId: normalizedAgentId || undefined,
          displayName: nextDisplayName,
          description: description.trim(),
          avatar: nextAvatar,
        })
        const nextAgentId = result.agentId || normalizedAgentId
        setDisplayName('')
        setAgentId('')
        setDescription('')
        setAvatar('')
      onClose()
      await onCreated?.(nextAgentId, nextDisplayName || nextAgentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : mode === 'edit' ? '保存 Agent 失败' : '创建 Agent 失败')
    } finally {
      setSaving(false)
    }
  }

  const title = mode === 'view' ? '查看 Agent' : mode === 'edit' ? '编辑 Agent' : '创建专属 Agent'
  const subtitle = mode === 'view' ? '系统内置 Agent 仅支持查看' : '为固定任务配置一个可复用助手'
  const closeLabel = mode === 'view' ? '关闭查看面板' : mode === 'edit' ? '关闭编辑面板' : '关闭创建面板'

  return (
    <div className="agent-panel-backdrop fixed inset-0 z-[70] flex justify-end bg-slate-950/35 backdrop-blur-[1px]">
      <button
        type="button"
        aria-label={closeLabel}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside className="agent-panel relative flex h-full w-full max-w-[460px] flex-col border-l border-light-border bg-light-bg shadow-2xl shadow-slate-950/20">
        <header className="flex items-center justify-between border-b border-light-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-blue/10 text-accent-blue">
              <Bot size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-light-text">{title}</h2>
              <p className="mt-0.5 text-xs text-light-text-secondary">{subtitle}</p>
            </div>
          </div>
          <IconButton label={closeLabel} onClick={onClose} surface="plain">
            <X size={18} />
          </IconButton>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <div>
              <label htmlFor="agent-display-name" className="mb-1.5 block text-xs font-medium text-light-text-secondary">
                展示名称
              </label>
              <div className="flex items-center gap-2 rounded-xl border border-light-border bg-light-card px-3 transition-colors focus-within:border-accent-blue/50">
                <Sparkles size={16} className="shrink-0 text-accent-blue" />
                <ClearableInput
                  id="agent-display-name"
                  value={displayName}
                  onValueChange={setDisplayName}
                  disabled={readOnly}
                  placeholder="例如：论文润色助手"
                  className="min-h-11 w-full bg-transparent text-sm text-light-text outline-none"
                  clearLabel="清空展示名称"
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-light-text-secondary">
                图标
              </div>
              <div className="flex items-center gap-2">
                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-light-card">
                  {avatar ? (
                    <img src={avatar} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Bot size={22} className="text-accent-blue" />
                  )}
                </div>
                {!readOnly && (
                  <IconButton
                    label="刷新生成图标"
                    onClick={refreshIcon}
                    disabled={generatingIcon}
                    tone="primary"
                  >
                    {generatingIcon ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  </IconButton>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="agent-description" className="mb-1.5 block text-xs font-medium text-light-text-secondary">
                任务说明
              </label>
              <ClearableTextarea
                id="agent-description"
                value={description}
                onValueChange={setDescription}
                rows={6}
                disabled={readOnly}
                placeholder="描述这个 Agent 擅长的任务、回答风格和需要遵守的边界。"
                className="w-full resize-none rounded-xl border border-light-border bg-light-card px-3 py-2 text-sm leading-6 text-light-text outline-none transition-colors placeholder:text-light-text-secondary focus:border-accent-blue/50"
                clearLabel="清空任务说明"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-accent-red/20 bg-accent-red/5 px-3 py-2 text-sm text-accent-red">
                {error}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-light-border px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="cursor-pointer rounded-xl border border-light-border px-4 py-2 text-sm text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text disabled:cursor-not-allowed disabled:opacity-60"
            >
              {readOnly ? '关闭' : '取消'}
            </button>
            {!readOnly && (
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                {mode === 'edit' ? '保存 Agent' : '创建 Agent'}
              </button>
            )}
          </footer>
        </form>
      </aside>
    </div>
  )
}
