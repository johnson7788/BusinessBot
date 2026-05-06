// API client for OpenClaw Platform Gateway (multi-tenant mode)

// Always use relative URL to go through Vite proxy, avoiding CORS preflight
const API_URL = ''

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  created_at: string
}

export interface AgentInfo {
  id: string
  name?: string | null
  workspace?: string
  model?: {
    primary?: string
    fallbacks?: string[]
  }
  identity?: {
    name?: string
    emoji?: string
    avatar?: string
    theme?: string
    avatarUrl?: string
  }
}

export interface AgentListResult {
  defaultId: string
  mainKey: string
  scope: string
  agents: AgentInfo[]
}

let agentsCache: AgentListResult | null = null
let agentsRequest: Promise<AgentListResult> | null = null
let sessionsCache: Session[] | null = null
let sessionsRequest: Promise<Session[]> | null = null

export interface CreateAgentInput {
  agentId?: string
  displayName: string
  description?: string
  avatar?: string
}

export interface CreateAgentResult {
  ok: boolean
  agentId: string
  name?: string
  workspace?: string
  model?: string
}

export interface AgentFileResult {
  agentId: string
  workspace: string
  file: {
    name: string
    path: string
    missing?: boolean
    size?: number
    updatedAtMs?: number
    content?: string
  }
}

export interface AgentIconResult {
  svg: string
  dataUrl: string
  id?: string
  url?: string
  sourceUrl?: string
  expiresInMs?: number
}

function hashText(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function escapeSvgText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function resolveRole(text: string): 'teacher' | 'developer' | 'doctor' | 'researcher' | 'writer' | 'manager' | 'assistant' {
  const lower = text.toLowerCase()
  if (/english|英语|grammar|语法|pronunciation|发音|language|语言|teacher|老师/.test(lower)) return 'teacher'
  if (/code|程序|开发|编程|program|developer|工程/.test(lower)) return 'developer'
  if (/doctor|医疗|医生|health|诊断|病|clinic/.test(lower)) return 'doctor'
  if (/research|研究|论文|资料|搜索|学术/.test(lower)) return 'researcher'
  if (/write|写作|文案|润色|编辑|内容/.test(lower)) return 'writer'
  if (/manager|管理|计划|项目|协调|运营/.test(lower)) return 'manager'
  return 'assistant'
}

function buildLocalAgentIcon(name: string, description: string, seed = ''): AgentIconResult {
  const palette = [
    ['#0891b2', '#22c55e'],
    ['#2563eb', '#06b6d4'],
    ['#7c3aed', '#ec4899'],
    ['#16a34a', '#84cc16'],
    ['#dc2626', '#f97316'],
    ['#0f766e', '#14b8a6'],
  ]
  const source = `${name}\n${description}\n${seed}`
  const hash = hashText(source)
  const [primary, secondary] = palette[hash % palette.length]
  const title = escapeSvgText(name || 'Agent')
  const role = resolveRole(`${name} ${description}`)
  const skin = ['#f7c59f', '#e8b48a', '#d99a72', '#f1d0b5'][hash % 4]
  const hair = ['#293241', '#3d2c2e', '#4a3428', '#1f2937'][(hash >>> 3) % 4]
  const shirt = ['#ffffff', '#ecfeff', '#f8fafc', '#eef2ff'][(hash >>> 5) % 4]
  const accessory =
    role === 'teacher'
      ? `<path d="M34 80h17v9H34z" fill="#fff" opacity=".9"/><path d="M37 83h11" stroke="${primary}" stroke-width="2" stroke-linecap="round"/>`
      : role === 'developer'
        ? `<rect x="72" y="70" width="20" height="14" rx="3" fill="#0f172a" opacity=".84"/><path d="M78 75l-3 2 3 2M86 75l3 2-3 2" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
        : role === 'doctor'
          ? `<path d="M79 69v16a9 9 0 0 1-18 0v-3" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="61" cy="82" r="4" fill="#fff"/>`
          : role === 'researcher'
            ? `<circle cx="83" cy="77" r="8" fill="none" stroke="#fff" stroke-width="4"/><path d="M89 83l7 7" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`
            : role === 'writer'
              ? `<path d="M78 67l13 13-14 6-5-5z" fill="#fff" opacity=".92"/><path d="M76 83l-3 7 7-3" fill="${secondary}"/>`
              : role === 'manager'
                ? `<path d="M78 68h16v22H78z" fill="#fff" opacity=".9"/><path d="M82 75h8M82 82h8" stroke="${primary}" stroke-width="2" stroke-linecap="round"/>`
                : `<circle cx="84" cy="78" r="9" fill="#fff" opacity=".9"/><path d="M80 78h8M84 74v8" stroke="${primary}" stroke-width="2.4" stroke-linecap="round"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="${title} icon">
  <defs>
    <linearGradient id="g" x1="18" y1="12" x2="102" y2="108" gradientUnits="userSpaceOnUse">
      <stop stop-color="${primary}"/>
      <stop offset="1" stop-color="${secondary}"/>
    </linearGradient>
    <clipPath id="r"><rect x="14" y="14" width="92" height="92" rx="28"/></clipPath>
  </defs>
  <rect x="14" y="14" width="92" height="92" rx="28" fill="url(#g)"/>
  <g clip-path="url(#r)">
    <circle cx="30" cy="30" r="18" fill="rgba(255,255,255,.16)"/>
    <circle cx="96" cy="96" r="30" fill="rgba(255,255,255,.13)"/>
    <path d="M33 112c4-24 18-37 36-37s32 13 36 37" fill="${shirt}" opacity=".96"/>
    <path d="M43 112c5-18 14-27 26-27s21 9 26 27" fill="${secondary}" opacity=".2"/>
    <circle cx="60" cy="48" r="24" fill="${skin}"/>
    <path d="M36 47c2-19 13-31 31-31 14 0 24 8 28 21-10-3-19-9-26-17-8 12-18 20-33 27z" fill="${hair}"/>
    <circle cx="51" cy="52" r="2.3" fill="#1f2937"/>
    <circle cx="69" cy="52" r="2.3" fill="#1f2937"/>
    <path d="M53 63c4 4 10 4 14 0" stroke="#7f1d1d" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    <path d="M44 45c-4 1-7 5-6 10 1 4 4 7 8 7" fill="${skin}" opacity=".96"/>
    <path d="M76 45c4 1 7 5 6 10-1 4-4 7-8 7" fill="${skin}" opacity=".96"/>
    ${accessory}
  </g>
</svg>`
  return {
    svg,
    dataUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
  }
}

export interface Session {
  key: string
  title?: string
  created_at: string | null
  updated_at: string | null
}

export interface SessionDetail {
  key: string
  messages: Array<{
    role: string
    content: string
    timestamp: string | null
  }>
  created_at: string | null
  updated_at: string | null
}

export interface AgentRunWaitResult {
  runId: string
  status: 'ok' | 'error' | 'timeout'
  startedAt: number | null
  endedAt: number | null
  error: unknown
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number | null
  content_type?: string | null
  modified: string
}

export interface BrowseDirectoryResult {
  type: 'directory'
  path: string
  root: string
  items: FileEntry[]
}

export interface BrowseFileResult {
  type: 'file'
  path: string
  name: string
  size: number
  content_type: string
  modified: string
  content?: string
}

export type BrowseResult = BrowseDirectoryResult | BrowseFileResult

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_KEY = 'openclaw_access_token'
const REFRESH_TOKEN_KEY = 'openclaw_refresh_token'

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
}

function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

export function isLoggedIn(): boolean {
  return getAccessToken() !== null
}

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

let refreshPromise: Promise<boolean> | null = null

async function parseErrorMessage(res: Response): Promise<string> {
  const fallback = `请求失败 (${res.status})`

  try {
    const body = await res.text()
    if (!body) return fallback

    try {
      const data = JSON.parse(body) as { detail?: string; message?: string }
      return data.detail || data.message || body || fallback
    } catch {
      return body || fallback
    }
  } catch {
    return fallback
  }
}

async function tryRefreshToken(): Promise<boolean> {
  const refresh = getRefreshToken()
  if (!refresh) return false

  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
      if (!res.ok) return false
      const data: TokenResponse = await res.json()
      setTokens(data.access_token, data.refresh_token)
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

export async function fetchJSON<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let res = await fetch(`${API_URL}${path}`, { ...options, headers })

  // On 401 attempt a silent token refresh and retry once
  if (res.status === 401 && token) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getAccessToken()}`
      res = await fetch(`${API_URL}${path}`, { ...options, headers })
    } else {
      clearTokens()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res))
  }

  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Auth functions
// ---------------------------------------------------------------------------

export async function login(
  username: string,
  password: string,
): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}



export function logout(): void {
  clearTokens()
  window.location.href = '/login'
}

export async function getMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/api/auth/me')
}

// ---------------------------------------------------------------------------
// Cron Jobs
// ---------------------------------------------------------------------------

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule_kind: string
  schedule_display: string
  schedule_expr: string | null
  schedule_every_ms: number | null
  message: string
  deliver: boolean
  channel: string | null
  to: string | null
  next_run_at_ms: number | null
  last_run_at_ms: number | null
  last_status: string | null
  last_error: string | null
  created_at_ms: number
}

export async function listCronJobs(includeDisabled = true): Promise<CronJob[]> {
  const params = includeDisabled ? '?include_disabled=true' : ''
  return fetchJSON<CronJob[]>(`/api/openclaw/cron/jobs${params}`)
}

export async function createCronJob(params: {
  name: string
  message: string
  every_seconds?: number
  cron_expr?: string
  at_iso?: string
}): Promise<CronJob> {
  return fetchJSON<CronJob>('/api/openclaw/cron/jobs', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function deleteCronJob(jobId: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  })
}

export async function toggleCronJob(jobId: string, enabled: boolean): Promise<CronJob> {
  return fetchJSON<CronJob>(
    `/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}/toggle`,
    {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    },
  )
}

export async function runCronJob(jobId: string): Promise<void> {
  await fetchJSON<unknown>(
    `/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}/run`,
    { method: 'POST' },
  )
}

// ---------------------------------------------------------------------------
// Agent functions
// ---------------------------------------------------------------------------

export async function listAgents(options: { force?: boolean } = {}): Promise<AgentListResult> {
  if (!options.force && agentsCache) return agentsCache
  if (!options.force && agentsRequest) return agentsRequest

  agentsRequest = fetchJSON<AgentListResult>('/api/openclaw/agents')
    .then(result => {
      agentsCache = result
      return result
    })
    .finally(() => {
      agentsRequest = null
    })

  return agentsRequest
}

export function invalidateAgentsCache(): void {
  agentsCache = null
  agentsRequest = null
}

function buildRandomAgentId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `assistant-${random}`
}

export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const displayName = input.displayName.trim()
  let result: CreateAgentResult | null = null
  let agentId = input.agentId?.trim() || buildRandomAgentId()

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      result = await fetchJSON<CreateAgentResult>('/api/openclaw/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: agentId,
          workspace: `~/.openclaw/workspace-${agentId}`,
          avatar: input.avatar?.trim() || undefined,
        }),
      })
      break
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('already exists') || input.agentId) {
        throw err
      }
      agentId = buildRandomAgentId()
    }
  }

  if (!result) throw new Error('创建 Agent 失败')

  if (displayName && displayName !== agentId) {
    fetchJSON(`/api/openclaw/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: displayName, avatar: input.avatar?.trim() || undefined }),
    }).catch(() => {})
  }

  const description = input.description?.trim()
  if (description) {
    fetchJSON(`/api/openclaw/agents/${encodeURIComponent(agentId)}/files/IDENTITY.md`, {
      method: 'PUT',
      body: JSON.stringify({
        content: `# ${displayName || agentId}\n\n${description}\n`,
      }),
    }).catch(() => {})
  }

  invalidateAgentsCache()
  return { ...result, agentId: result.agentId || agentId }
}

export async function updateAgentName(agentId: string, displayName: string, avatar?: string): Promise<{ ok: boolean; agentId: string }> {
  const result = await fetchJSON<{ ok: boolean; agentId: string }>(`/api/openclaw/agents/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: displayName.trim(), avatar: avatar?.trim() || undefined }),
  })
  invalidateAgentsCache()
  return result
}

export async function generateAgentIcon(
  name: string,
  description: string,
  seed = '',
  previousIconId = '',
): Promise<AgentIconResult> {
  try {
    const result = await fetchJSON<AgentIconResult>('/api/openclaw/agents/icon', {
      method: 'POST',
      body: JSON.stringify({ name, description, seed, previousIconId }),
    })
    if (result.url?.startsWith('/api/')) {
      const sourceUrl = `/api/openclaw${result.url.slice('/api'.length)}`
      const token = getAccessToken()
      const imageRes = await fetch(sourceUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!imageRes.ok) throw new Error(`图标加载失败 (${imageRes.status})`)
      const svg = await imageRes.text()
      return {
        ...result,
        svg,
        sourceUrl,
        dataUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      }
    }
    return result
  } catch {
    return buildLocalAgentIcon(name, description, seed)
  }
}

export async function getAgentFile(agentId: string, name: string): Promise<AgentFileResult> {
  return fetchJSON<AgentFileResult>(
    `/api/openclaw/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
  )
}

export async function setAgentFile(agentId: string, name: string, content: string): Promise<AgentFileResult> {
  return fetchJSON<AgentFileResult>(
    `/api/openclaw/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
  )
}

export async function deleteAgent(agentId: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/agents/${encodeURIComponent(agentId)}?delete_files=true`, {
    method: 'DELETE',
  })
  invalidateAgentsCache()
}

// ---------------------------------------------------------------------------
// Session functions
// ---------------------------------------------------------------------------

export async function listSessions(options: { force?: boolean } = {}): Promise<Session[]> {
  if (!options.force && sessionsCache) return sessionsCache
  if (!options.force && sessionsRequest) return sessionsRequest

  sessionsRequest = fetchJSON<Session[]>('/api/openclaw/sessions')
    .then(result => {
      sessionsCache = result
      return result
    })
    .finally(() => {
      sessionsRequest = null
    })

  return sessionsRequest
}

export function invalidateSessionsCache(): void {
  sessionsCache = null
  sessionsRequest = null
}

export async function getSession(key: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/openclaw/sessions/${encodeURIComponent(key)}`)
}

export async function deleteSession(key: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/sessions/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  invalidateSessionsCache()
}

export async function updateSessionTitle(
  key: string,
  title: string,
): Promise<{ ok: boolean; key: string; title: string | null }> {
  const result = await fetchJSON<{ ok: boolean; key: string; title: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(key)}/title`,
    {
      method: 'PUT',
      body: JSON.stringify({ title }),
    },
  )
  invalidateSessionsCache()
  return result
}

export async function generateSessionTitle(
  key: string,
  message: string,
): Promise<{ ok: boolean; key: string; title: string | null }> {
  const result = await fetchJSON<{ ok: boolean; key: string; title: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(key)}/title-summary`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  )
  invalidateSessionsCache()
  return result
}

// ---------------------------------------------------------------------------
// Chat functions
// ---------------------------------------------------------------------------

export async function sendChatMessage(
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; runId: string | null; title?: string | null }> {
  const result = await fetchJSON<{ ok: boolean; runId: string | null; title?: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  )
  invalidateSessionsCache()
  return result
}

export async function waitForAgentRun(
  runId: string,
  timeoutMs = 25000,
): Promise<AgentRunWaitResult> {
  const params = new URLSearchParams({ timeoutMs: String(timeoutMs) })
  return fetchJSON<AgentRunWaitResult>(
    `/api/openclaw/runs/${encodeURIComponent(runId)}/wait?${params.toString()}`,
  )
}

export async function abortAgentRun(
  runId: string,
  sessionKey: string,
): Promise<{ ok?: boolean }> {
  return fetchJSON<{ ok?: boolean }>(`/api/openclaw/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    body: JSON.stringify({ sessionKey }),
  })
}

export async function abortActiveSessionRun(sessionKey: string): Promise<{ ok?: boolean }> {
  return fetchJSON<{ ok?: boolean }>(
    `/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/abort-active`,
    { method: 'POST' },
  )
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

export async function uploadFileToWorkspace(
  file: File,
  uploadDir: string,
): Promise<{ name?: string; path?: string; file_id?: string; url?: string }> {
  const token = getAccessToken()
  const formData = new FormData()
  formData.append('file', file)
  formData.append('path', uploadDir)

  const res = await fetch(`${API_URL}/api/openclaw/filemanager/upload`, {
    method: 'POST',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    body: formData,
  })

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res))
  }

  return res.json() as Promise<{ path: string }>
}

// ---------------------------------------------------------------------------
// File manager
// ---------------------------------------------------------------------------

export async function browseFiles(path = ''): Promise<BrowseResult> {
  const params = path ? `?path=${encodeURIComponent(path)}` : ''
  return fetchJSON<BrowseResult>(`/api/openclaw/filemanager/browse${params}`)
}

export async function uploadFile(file: File, targetDir = ''): Promise<FileEntry> {
  const token = getAccessToken()
  const formData = new FormData()
  formData.append('file', file)
  if (targetDir) formData.append('path', targetDir)

  const res = await fetch(`${API_URL}/api/openclaw/filemanager/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res))
  }

  return res.json() as Promise<FileEntry>
}

export async function deleteFile(path: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/filemanager/delete?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
}

export async function createDirectory(path: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/filemanager/mkdir?path=${encodeURIComponent(path)}`, {
    method: 'POST',
  })
}

export async function writeManagedFile(path: string, content: string): Promise<FileEntry> {
  try {
    return await fetchJSON<FileEntry>('/api/openclaw/filemanager/write', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (!message.includes('Cannot PUT /api/filemanager/write')) {
      throw err
    }

    const normalizedPath = path.replace(/\\/g, '/')
    const slashIndex = normalizedPath.lastIndexOf('/')
    const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath
    const targetDir = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : ''
    if (!fileName) throw err

    const file = new File([content], fileName, { type: 'text/plain;charset=utf-8' })
    return uploadFile(file, targetDir)
  }
}

export async function downloadManagedFile(entry: FileEntry): Promise<void> {
  const token = getAccessToken()
  const res = await fetch(
    `${API_URL}/api/openclaw/filemanager/download?path=${encodeURIComponent(entry.path)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res))
  }

  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = entry.name
  link.click()
  URL.revokeObjectURL(blobUrl)
}
