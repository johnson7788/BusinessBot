import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  ArrowLeft,
  BookOpen,
  Bot,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import ClearableInput from '../components/ui/ClearableInput.tsx'
import IconButton from '../components/ui/IconButton.tsx'
import Popconfirm from '../components/ui/Popconfirm.tsx'
import {
  browseFiles,
  createDirectory,
  deleteFile,
  downloadManagedFile,
  uploadFile,
  writeManagedFile,
} from '../lib/api.ts'
import type { BrowseDirectoryResult, BrowseFileResult, FileEntry } from '../lib/api.ts'
import type { LayoutOutletContext } from '../components/Layout.tsx'
import type { AgentInfo } from '../lib/api.ts'

const retiredBuiltInAgentIds = new Set(['manager', 'programmer', 'researcher', 'hr', 'doctor'])
const maxUploadSizeLabel = '50MB'

function trimSlashes(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function knowledgeRoot(agent: AgentInfo | undefined, agentId: string): string {
  const workspace = agent?.workspace?.trim()
  if (workspace) return `${trimSlashes(workspace)}/knowledge`
  if (agentId === 'main') return 'workspace/knowledge'
  return `workspace-${agentId}/knowledge`
}

function getAgentName(agent: { id: string; name?: string | null; identity?: { name?: string } }): string {
  if (agent.id === 'main') return '默认'
  return agent.identity?.name || agent.name || agent.id
}

function fullPath(agent: AgentInfo | undefined, agentId: string, subPath: string): string {
  const root = knowledgeRoot(agent, agentId)
  return subPath ? `${root}/${subPath}` : root
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isTextFile(entry: FileEntry): boolean {
  const contentType = entry.content_type || ''
  const extension = entry.name.split('.').pop()?.toLowerCase() || ''
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    ['md', 'json', 'yml', 'yaml', 'toml', 'jsonl', 'txt', 'xml', 'csv', 'log', 'sh', 'ts', 'js', 'py'].includes(extension)
  )
}

function KnowledgeSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="rounded-lg border border-light-border bg-light-card p-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 border-b border-light-border/70 py-3 last:border-b-0">
            <span className="skeleton-shimmer h-8 w-8 rounded-lg" />
            <span className="skeleton-shimmer h-4 flex-1 rounded-full" />
            <span className="skeleton-shimmer hidden h-4 w-20 rounded-full sm:block" />
            <span className="skeleton-shimmer hidden h-4 w-28 rounded-full md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function KnowledgeBase() {
  const { agents, agentsLoading, refreshAgents, openMobileSidebar } = useOutletContext<LayoutOutletContext>()
  const [selectedAgent, setSelectedAgent] = useState('')
  const [subPath, setSubPath] = useState('')
  const [data, setData] = useState<BrowseDirectoryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; content: string; originalContent: string } | null>(null)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorStatus, setEditorStatus] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const availableAgents = useMemo(
    () => agents.filter(agent => agent.id && !retiredBuiltInAgentIds.has(agent.id)),
    [agents],
  )
  const selectedAgentInfo = availableAgents.find(agent => agent.id === selectedAgent)
  const breadcrumbs = subPath ? subPath.split('/') : []

  useEffect(() => {
    if (selectedAgent || availableAgents.length === 0) return
    const mainAgent = availableAgents.find(agent => agent.id === 'main')
    setSelectedAgent((mainAgent || availableAgents[0]).id)
  }, [availableAgents, selectedAgent])

  const loadDir = useCallback(async (agentId: string, nextSubPath: string, options: { keepEditor?: boolean } = {}) => {
    if (!agentId) return
    const agent = availableAgents.find(item => item.id === agentId)
    setLoading(true)
    setError('')
    if (!options.keepEditor) {
      setEditorFile(null)
      setEditorStatus('')
    }
    try {
      const result = await browseFiles(fullPath(agent, agentId, nextSubPath))
      if (result.type !== 'directory') throw new Error('目标不是文件夹')
      setData(result)
      setSubPath(nextSubPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败'
      if (message.includes('404') || message.toLowerCase().includes('not found') || message.includes('Path not found')) {
        try {
          await createDirectory(fullPath(agent, agentId, nextSubPath))
          const result = await browseFiles(fullPath(agent, agentId, nextSubPath))
          if (result.type !== 'directory') throw new Error('目标不是文件夹')
          setData(result)
          setSubPath(nextSubPath)
        } catch (createErr) {
          setError(createErr instanceof Error ? createErr.message : '加载失败')
        }
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [availableAgents])

  useEffect(() => {
    if (!selectedAgent) return
    void loadDir(selectedAgent, '')
  }, [loadDir, selectedAgent])

  const closeEditor = () => {
    setEditorFile(null)
    setEditorLoading(false)
    setEditorStatus('')
  }

  const navigateTo = (nextSubPath: string) => {
    void loadDir(selectedAgent, nextSubPath)
  }

  const goUp = () => {
    if (!subPath) return
    navigateTo(subPath.split('/').slice(0, -1).join('/'))
  }

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0 || !selectedAgent) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await uploadFile(file, fullPath(selectedAgentInfo, selectedAgent, subPath))
      }
      await loadDir(selectedAgent, subPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleNewFolder = async () => {
    const folderName = newFolderName.trim()
    if (!folderName || !selectedAgent) return
    setError('')
    try {
      await createDirectory(`${fullPath(selectedAgentInfo, selectedAgent, subPath)}/${folderName}`)
      setNewFolderOpen(false)
      setNewFolderName('')
      await loadDir(selectedAgent, subPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    }
  }

  const handleDelete = async (entry: FileEntry) => {
    setDeleting(entry.path)
    setError('')
    try {
      await deleteFile(entry.path)
      await loadDir(selectedAgent, subPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(null)
    }
  }

  const handleEditFile = async (entry: FileEntry) => {
    setEditorLoading(true)
    setEditorStatus('')
    try {
      const result = await browseFiles(entry.path)
      const fileResult = result as BrowseFileResult
      if (fileResult.content === undefined) {
        throw new Error('这个文件过大或暂不支持在线编辑')
      }
      const content = fileResult.content
      setEditorFile({
        path: entry.path,
        name: entry.name,
        content,
        originalContent: content,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载文件内容')
    } finally {
      setEditorLoading(false)
    }
  }

  const handleSaveEditor = useCallback(async () => {
    if (!editorFile || editorSaving) return
    setEditorSaving(true)
    setEditorStatus('')
    setError('')
    try {
      await writeManagedFile(editorFile.path, editorFile.content)
      setEditorFile(current => current ? { ...current, originalContent: current.content } : current)
      setEditorStatus(`已保存 ${formatDate(new Date().toISOString())}`)
      if (selectedAgent) await loadDir(selectedAgent, subPath, { keepEditor: true })
    } catch (err) {
      setEditorStatus('')
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setEditorSaving(false)
    }
  }, [editorFile, editorSaving, loadDir, selectedAgent, subPath])

  useEffect(() => {
    if (!editorFile) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void handleSaveEditor()
      }
      if (event.key === 'Escape') {
        closeEditor()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editorFile, handleSaveEditor])

  const handleDownload = async (entry: FileEntry) => {
    setError('')
    try {
      await downloadManagedFile(entry)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败')
    }
  }

  const editorDirty = editorFile ? editorFile.content !== editorFile.originalContent : false

  return (
    <div className="h-full overflow-y-auto bg-light-bg">
      <div className="flex min-h-full w-full flex-col px-4 py-5 sm:px-5 lg:px-6">
        <header className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <button
              type="button"
              onClick={openMobileSidebar}
              className="mb-3 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-light-border bg-light-card px-3 py-2 text-sm text-light-text-secondary shadow-sm transition-colors hover:bg-light-card-hover hover:text-light-text lg:hidden"
            >
              <ArrowLeft size={16} />
              菜单
            </button>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-blue/10 text-accent-blue">
                <BookOpen size={22} />
              </span>
              <div>
                <h1 className="text-2xl font-bold leading-tight tracking-normal text-light-text sm:text-[28px]">
                  知识库
                </h1>
                <p className="mt-1 text-sm text-light-text-secondary">
                  为不同 AI 面板整理可引用的文档、数据和资料
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <IconButton
              label="刷新知识库"
              onClick={() => {
                void refreshAgents({ force: true })
                if (selectedAgent) void loadDir(selectedAgent, subPath)
              }}
              tone="primary"
              className="border border-light-border bg-light-card shadow-sm"
            >
              <RefreshCw size={17} />
            </IconButton>
            <button
              type="button"
              onClick={() => setNewFolderOpen(true)}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-light-border bg-light-card px-4 py-2.5 text-sm font-medium text-light-text transition-colors hover:bg-light-card-hover"
            >
              <FolderPlus size={17} className="text-accent-blue" />
              新建文件夹
            </button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-cyan-900/10 transition-colors hover:bg-cyan-700">
              {uploading ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />}
              上传文件
              <input ref={fileInputRef} type="file" multiple className="hidden" title={`单文件最大 ${maxUploadSizeLabel}`} onChange={handleUpload} />
            </label>
          </div>
        </header>

        <div className="mb-4 rounded-lg border border-accent-blue/20 bg-accent-blue/5 px-4 py-3 text-sm leading-6 text-light-text-secondary">
          <span className="font-medium text-light-text">上传提示：</span>
          单文件最大 {maxUploadSizeLabel}。当前可以上传并管理多种文件，但只有 Markdown 文件会进入知识库检索索引；Word、Excel、图片、音频和其他二进制文件暂时仅作为附件保存。
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <aside className="shrink-0 rounded-lg border border-light-border bg-light-card p-3 shadow-sm shadow-slate-200/40 lg:w-64">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Bot size={16} className="shrink-0 text-accent-blue" />
                <span className="text-sm font-semibold text-light-text">选择 Agent</span>
              </div>
              {selectedAgentInfo && (
                <span className="shrink-0 rounded-full bg-accent-blue/10 px-2 py-0.5 text-xs font-medium text-accent-blue">
                  {getAgentName(selectedAgentInfo)}
                </span>
              )}
            </div>

            {agentsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-2 rounded-xl px-2 py-2">
                    <span className="skeleton-shimmer h-7 w-7 rounded-lg" />
                    <span className="skeleton-shimmer h-3.5 flex-1 rounded-full" />
                  </div>
                ))}
              </div>
            ) : availableAgents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-light-border bg-light-card-hover px-3 py-6 text-center text-sm text-light-text-secondary">
                暂无可用 Agent
              </div>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1 lg:max-h-[calc(100vh-220px)]">
                {availableAgents.map(agent => {
                  const active = agent.id === selectedAgent
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => setSelectedAgent(agent.id)}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                        active
                          ? 'bg-accent-blue text-white shadow-sm shadow-cyan-900/10'
                          : 'text-light-text-secondary hover:bg-light-card-hover hover:text-light-text'
                      }`}
                    >
                      <Bot size={15} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{getAgentName(agent)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div className="mb-4 rounded-lg border border-accent-red/20 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
                {error}
              </div>
            )}

            {newFolderOpen && (
              <div className="mb-4 flex flex-col gap-2 rounded-lg border border-light-border bg-light-card p-3 shadow-sm sm:flex-row sm:items-center">
                <ClearableInput
                  value={newFolderName}
                  onValueChange={setNewFolderName}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void handleNewFolder()
                    if (event.key === 'Escape') setNewFolderOpen(false)
                  }}
                  autoFocus
                  clearLabel="清空文件夹名称"
                  placeholder="输入文件夹名称"
                  className="min-w-0 flex-1 rounded-xl border border-light-border bg-light-card px-3 py-2 text-sm text-light-text outline-none transition-colors placeholder:text-light-text-secondary focus:border-accent-blue"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleNewFolder()}
                    className="flex-1 cursor-pointer rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-700 sm:flex-none"
                  >
                    创建
                  </button>
                  <IconButton label="取消新建文件夹" onClick={() => setNewFolderOpen(false)}>
                    <X size={17} />
                  </IconButton>
                </div>
              </div>
            )}

            <section className="min-h-0 flex-1 rounded-lg border border-light-border bg-light-card shadow-sm shadow-slate-200/40">
          <div className="flex flex-col gap-3 border-b border-light-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => navigateTo('')}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 font-medium text-light-text transition-colors hover:bg-light-card-hover"
              >
                <BookOpen size={15} className="text-accent-blue" />
                知识库
              </button>
              {breadcrumbs.map((segment, index) => {
                const segmentPath = breadcrumbs.slice(0, index + 1).join('/')
                const isLast = index === breadcrumbs.length - 1
                return (
                  <span key={segmentPath} className="flex min-w-0 items-center gap-1">
                    <ChevronRight size={14} className="shrink-0 text-light-text-secondary" />
                    {isLast ? (
                      <span className="truncate rounded-lg bg-light-card-hover px-2 py-1 font-medium text-light-text">
                        {segment}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigateTo(segmentPath)}
                        className="cursor-pointer truncate rounded-lg px-2 py-1 text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
                      >
                        {segment}
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
            {subPath && (
              <button
                type="button"
                onClick={goUp}
                className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-light-border bg-light-card px-3 py-2 text-sm text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
              >
                <ArrowLeft size={16} />
                返回上级
              </button>
            )}
          </div>

          {loading ? (
            <div className="p-4">
              <KnowledgeSkeleton />
            </div>
          ) : data?.items.length ? (
            <div className="divide-y divide-light-border/80">
              {data.items.map(entry => {
                const isDir = entry.type === 'directory'
                const isDeleting = deleting === entry.path
                const entrySubPath = subPath ? `${subPath}/${entry.name}` : entry.name
                return (
                  <div key={entry.path}>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 transition-colors hover:bg-light-card-hover/70 md:grid-cols-[minmax(0,1fr)_110px_150px_96px]">
                      <button
                        type="button"
                        onClick={() => {
                          if (isDir) navigateTo(entrySubPath)
                          else if (isTextFile(entry)) void handleEditFile(entry)
                        }}
                        className={`flex min-w-0 cursor-pointer items-center gap-3 text-left ${
                          isDir || isTextFile(entry) ? 'text-light-text hover:text-accent-blue' : 'text-light-text'
                        }`}
                      >
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                          isDir ? 'bg-accent-yellow/10 text-amber-600' : 'bg-accent-blue/10 text-accent-blue'
                        }`}>
                          {isDir ? <Folder size={18} /> : <FileText size={18} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{entry.name}</span>
                          <span className="mt-0.5 block text-xs text-light-text-secondary md:hidden">
                            {isDir ? '文件夹' : formatSize(entry.size)} · {formatDate(entry.modified)}
                          </span>
                        </span>
                      </button>
                      <span className="hidden items-center justify-end text-xs text-light-text-secondary md:flex">
                        {isDir ? '文件夹' : formatSize(entry.size)}
                      </span>
                      <span className="hidden items-center justify-end text-xs text-light-text-secondary md:flex">
                        {formatDate(entry.modified)}
                      </span>
                      <div className="flex items-center justify-end gap-1">
                        {!isDir && (
                          <IconButton label="下载" onClick={() => void handleDownload(entry)} tone="primary" surface="plain">
                            <Download size={16} />
                          </IconButton>
                        )}
                        <Popconfirm
                          title={`删除${isDir ? '文件夹' : '文件'}？`}
                          description={`“${entry.name}”将从当前知识库中删除，此操作不可恢复。`}
                          confirmText="删除"
                          danger
                          onConfirm={() => handleDelete(entry)}
                        >
                          <button
                            type="button"
                            disabled={isDeleting}
                            className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-light-text-secondary transition-colors hover:bg-accent-red/10 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="删除"
                          >
                            {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                          </button>
                        </Popconfirm>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-[300px] flex-col items-center justify-center px-5 py-12 text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue/10 text-accent-blue">
                <BookOpen size={28} />
              </span>
              <h3 className="text-base font-semibold text-light-text">这个知识库还是空的</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-light-text-secondary">
                上传 Markdown 文档或创建文件夹后，当前 AI 面板就可以在对话中检索这些资料。
              </p>
            </div>
          )}
            </section>
          </div>
        </div>
      </div>

      {(editorFile || editorLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-3 py-4 sm:px-6 sm:py-6">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-slate-950/55 backdrop-blur-[2px]"
            aria-label="关闭文件编辑器"
            onClick={closeEditor}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="编辑知识库文件"
            className="relative flex h-[min(88vh,900px)] w-full max-w-[min(1440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-light-border bg-light-card shadow-2xl shadow-slate-950/25"
          >
            <header className="flex min-h-14 items-center justify-between gap-3 border-b border-light-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-light-text">
                  {editorFile?.name || '正在读取文件'}
                </h2>
                <p className="mt-0.5 truncate text-xs text-light-text-secondary">
                  {editorFile?.path || '请稍候'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {editorStatus && (
                  <span className="hidden text-xs text-light-text-secondary sm:inline">
                    {editorStatus}
                  </span>
                )}
                {editorDirty && (
                  <span className="rounded-full bg-accent-yellow/10 px-2 py-1 text-xs font-medium text-amber-700">
                    未保存
                  </span>
                )}
                <button
                  type="button"
                  disabled={!editorFile || editorSaving}
                  onClick={() => void handleSaveEditor()}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-accent-blue px-4 py-2 text-sm font-medium text-white shadow-sm shadow-cyan-900/10 transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {editorSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  保存
                </button>
                <IconButton label="关闭编辑器" onClick={closeEditor} className="border border-light-border">
                  <X size={17} />
                </IconButton>
              </div>
            </header>

            {editorLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-light-text-secondary">
                <Loader2 size={18} className="animate-spin text-accent-blue" />
                正在读取文件内容
              </div>
            ) : (
              <textarea
                value={editorFile?.content || ''}
                onChange={event => {
                  const value = event.target.value
                  setEditorFile(current => current ? { ...current, content: value } : current)
                  setEditorStatus('')
                }}
                spellCheck={false}
                autoFocus
                className="min-h-0 flex-1 resize-none border-0 bg-light-card px-4 py-4 font-mono text-sm leading-6 text-light-text outline-none placeholder:text-light-text-secondary"
              />
            )}

            <footer className="flex min-h-10 items-center justify-between gap-3 border-t border-light-border px-4 py-2 text-xs text-light-text-secondary">
              <span className="truncate">Ctrl+S 保存到 workspace 对应文件</span>
              {editorStatus && <span className="truncate sm:hidden">{editorStatus}</span>}
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
