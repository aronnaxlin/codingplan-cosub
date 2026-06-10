import React, { FormEvent, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Clock,
  Copy,
  Gauge,
  KeyRound,
  Lock,
  LogOut,
  PauseCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  User,
  Users
} from 'lucide-react'
import './styles.css'

type UserRole = 'admin' | 'user'

type User = {
  id: string
  username: string
  role: UserRole
  createdAt?: string
  updatedAt?: string
}

type AuthState = {
  token: string
  user: User
}

type AdminPage = 'dashboard' | 'keys' | 'usage' | 'settings' | 'users'
type UserPage = 'my-keys' | 'settings'
type Page = AdminPage | UserPage

type UsageWindow = {
  requests: number
  tokens: number
  errors: number
}

type QuotaWindow = {
  requests: number
  tokens: number
}

type DynamicWindow = {
  dynamicLimit: number
  remaining: number
  tokenDynamicLimit: number
  tokenRemaining: number
  officialRemaining: number | null
  inferredTotal: number | null
  effectiveTotal?: number
  externalUsageTokens?: number
  reserveAbsorbedTokens?: number
  userPoolScale?: number
  confidence?: number
}

type DynamicLimits = {
  fiveHours: DynamicWindow
  week: DynamicWindow
} | null

type ProxyKey = {
  id: string
  name: string
  keyPreview: string
  secret: string
  active: boolean
  quotaPercent: number
  concurrencyLimit: number
  notes: string
  assignedToUserId: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  usage: {
    fiveHours: UsageWindow
    week: UsageWindow
  }
  limits: {
    fiveHours: QuotaWindow
    week: QuotaWindow
  }
  percentages: {
    fiveHours: QuotaWindow
    week: QuotaWindow
  }
  dynamicLimits: DynamicLimits
}

type UsageEntry = {
  id: string
  createdAt: string
  keyId: string
  keyName: string
  path: string
  method: string
  model: string
  status: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  userAgent: string
  errorCode: string
}

type Stats = {
  totalKeys: number
  activeKeys: number
  todayRequests: number
  totalRequests: number
  todayTokens: number
  totalTokens: number
  errors: number
  avgLatency: number
  hasUpstreamKey: boolean
  officialUsage: OfficialUsage | null
  refreshInfo: RefreshInfo
  settings: SettingsState
  concurrency: {
    globalActive: number
    byKey: Record<string, number>
  }
}

type SettingsState = {
  upstreamBaseUrl: string
  globalConcurrencyLimit: number
  keepUsageDays: number
  quotaCheckEnabled: boolean
  quotaCheckIntervalMinutes: number
  quotaCheckOn429: boolean
  quotaCheckUserAgent: string
  memberCount: number
  reservePercent: number
  externalUsageWeight: number
  defaultQuotaPercent: number
  totalFiveHourRequestLimit: number
  totalWeeklyRequestLimit: number
  totalFiveHourTokenLimit: number
  totalWeeklyTokenLimit: number
  hasUpstreamKey?: boolean
}

type OfficialQuota = {
  limit: number | null
  used: number | null
  remaining: number | null
  percentUsed: number | null
  remainingPercent: number | null
  resetTime: string | null
  secondsUntilReset: number | null
  health: 'healthy' | 'warning' | 'critical' | 'unknown'
}

type OfficialUsage = {
  ok: boolean
  status?: number
  error?: string
  fetchedAt: string
  userAgent?: string
  plan?: string | null
  weekly?: OfficialQuota | null
  session?: (OfficialQuota & { windowMs?: number | null }) | null
  largestWindow?: (OfficialQuota & { windowMs?: number | null }) | null
  parallelLimit?: number | null
}

type RefreshInfo = {
  nextRefreshInSeconds: number | null
  intervalMinutes: number
  reason: string
  minRemainingPercent: number
}

const defaultKeyForm = {
  name: '',
  active: true,
  quotaPercent: 45,
  concurrencyLimit: 1,
  notes: '',
  assignedToUserId: ''
}

const quotaPresets = {
  andante: {
    label: 'Code Andante',
    totalFiveHourRequestLimit: 359,
    totalWeeklyRequestLimit: 639,
    totalFiveHourTokenLimit: 15000000,
    totalWeeklyTokenLimit: 21000000
  },
  allegretto: {
    label: 'Code Allegretto',
    totalFiveHourRequestLimit: 1307,
    totalWeeklyRequestLimit: 9073,
    totalFiveHourTokenLimit: 65000000,
    totalWeeklyTokenLimit: 357000000
  }
} as const

function readAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem('kcp_auth')
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveAuth(auth: AuthState | null) {
  if (auth) localStorage.setItem('kcp_auth', JSON.stringify(auth))
  else localStorage.removeItem('kcp_auth')
}

function fmtNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value || 0)
}

function fmtDate(value?: string | null) {
  if (!value) return '未使用'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function percent(used: number, limit: number) {
  if (!limit) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

function fmtCountdown(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '未知'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) return `${d}天${h}小时${m}分`
  if (h > 0) return `${h}小时${m}分${s}秒`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

function healthClass(health?: string) {
  switch (health) {
    case 'healthy': return 'health-healthy'
    case 'warning': return 'health-warning'
    case 'critical': return 'health-critical'
    default: return 'health-unknown'
  }
}

function classNames(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(' ')
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(readAuth())

  if (!auth) {
    return <LoginPage onLogin={setAuth} />
  }

  if (auth.user.role === 'admin') {
    return <AdminApp auth={auth} onLogout={() => { saveAuth(null); setAuth(null) }} />
  }

  return <UserApp auth={auth} onLogout={() => { saveAuth(null); setAuth(null) }} />
}

function LoginPage({ onLogin }: { onLogin: (auth: AuthState) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || '登录失败')
      }
      saveAuth(data)
      onLogin(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-mark">
          <ShieldCheck size={28} />
        </div>
        <h1>coding-plan-proxy</h1>
        <p>输入账号密码登录管理面板。</p>
        {error && <div className="notice">{error}</div>}
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            type="password"
            required
          />
        </label>
        <button className="primary-button" type="submit" disabled={loading}>
          <Lock size={16} />
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </main>
  )
}

function AdminApp({ auth, onLogout }: { auth: AuthState; onLogout: () => void }) {
  const [page, setPage] = useState<AdminPage>('dashboard')
  const [stats, setStats] = useState<Stats | null>(null)
  const [keys, setKeys] = useState<ProxyKey[]>([])
  const [usage, setUsage] = useState<UsageEntry[]>([])
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [officialUsage, setOfficialUsage] = useState<OfficialUsage | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [keyForm, setKeyForm] = useState(defaultKeyForm)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('kcp_sidebar_collapsed') === 'true' } catch { return false }
  })

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        ...(init.headers || {})
      }
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || response.statusText)
    }
    if (response.status === 204) return null as T
    return response.json() as Promise<T>
  }

  async function loadAll() {
    setLoading(true)
    setNotice('')
    try {
      const [nextStats, nextKeys, nextUsage, nextSettings, nextUsers] = await Promise.all([
        api<Stats>('/api/admin/stats'),
        api<ProxyKey[]>('/api/admin/keys'),
        api<UsageEntry[]>('/api/admin/usage?limit=150'),
        api<SettingsState>('/api/admin/settings'),
        api<User[]>('/api/admin/users')
      ])
      setStats(nextStats)
      setKeys(nextKeys)
      setUsage(nextUsage)
      setSettings(nextSettings)
      setOfficialUsage(nextStats.officialUsage)
      setUsers(nextUsers)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [auth.token])

  const nav = [
    { id: 'dashboard' as AdminPage, label: '总览', icon: BarChart3 },
    { id: 'keys' as AdminPage, label: 'Proxy Keys', icon: KeyRound },
    { id: 'usage' as AdminPage, label: '审计日志', icon: Activity },
    { id: 'settings' as AdminPage, label: '设置', icon: Settings },
    { id: 'users' as AdminPage, label: '用户管理', icon: Users }
  ]

  async function createKey(event: FormEvent) {
    event.preventDefault()
    const body = { ...keyForm }
    if (!body.assignedToUserId) delete (body as any).assignedToUserId
    const created = await api<{ key: ProxyKey; secret: string }>('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    setNewSecret(created.secret)
    setShowCreate(false)
    setKeyForm(defaultKeyForm)
    await loadAll()
  }

  async function updateKey(id: string, patch: Partial<ProxyKey>) {
    await api<ProxyKey>(`/api/admin/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    })
    await loadAll()
  }

  async function rotateKey(id: string) {
    const rotated = await api<{ key: ProxyKey; secret: string }>(`/api/admin/keys/${id}/rotate`, {
      method: 'POST'
    })
    setNewSecret(rotated.secret)
    await loadAll()
  }

  async function deleteKey(id: string) {
    if (!confirm('确认删除这个 proxy key？')) return
    await api(`/api/admin/keys/${id}`, { method: 'DELETE' })
    await loadAll()
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    const saved = await api<SettingsState>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings)
    })
    setSettings(saved)
    await loadAll()
  }

  async function refreshOfficialUsage() {
    if (!settings?.quotaCheckEnabled) {
      setNotice('官方额度检查未启用，已阻止上游请求')
      return
    }
    setNotice('')
    try {
      const result = await api<OfficialUsage>('/api/admin/official-usage/refresh', { method: 'POST' })
      setOfficialUsage(result)
      await loadAll()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '官方额度刷新失败')
      await loadAll()
    }
  }

  async function applyQuotaAllocation() {
    await api('/api/admin/quota-allocation/apply', { method: 'POST' })
    await loadAll()
  }

  function openCreateKeyForm() {
    setKeyForm({
      ...defaultKeyForm,
      quotaPercent: settings?.defaultQuotaPercent ?? 45
    })
    setShowCreate(true)
  }

  const selectedTitle = useMemo(() => nav.find((item) => item.id === page)?.label || '总览', [page])

  const userMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const u of users) map[u.id] = u.username
    return map
  }, [users])

  const toggleSidebar = () => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    try { localStorage.setItem('kcp_sidebar_collapsed', String(next)) } catch {}
  }

  return (
    <div className={classNames('app-shell', sidebarCollapsed && 'sidebar-collapsed')}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-box">
            <ShieldCheck size={22} />
          </div>
          <div className="sidebar-brand-text">
            <strong>coding-plan-proxy</strong>
            <span>internal quota gateway</span>
          </div>
          <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? '展开' : '收起'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points={sidebarCollapsed ? "9 18 15 12 9 6" : "15 18 9 12 15 6"} />
            </svg>
          </button>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={classNames('nav-item', page === item.id && 'active')}
                onClick={() => setPage(item.id)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-badge">
            <User size={14} />
            <span>{auth.user.username}</span>
            <span className="role-tag">{auth.user.role}</span>
          </div>
          <div className="sidebar-actions">
            <button className="ghost-button" onClick={() => void loadAll()} title="刷新">
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
              <span>刷新</span>
            </button>
            <button className="ghost-button logout-btn" onClick={onLogout}>
              <LogOut size={14} />
              <span>退出</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>{selectedTitle}</h1>
            <p>只做真实客户端透传、内部限额、并发控制和审计。</p>
          </div>
          <div className={classNames('status-pill', stats?.hasUpstreamKey ? 'ok' : 'warn')}>
            {stats?.hasUpstreamKey ? <Check size={16} /> : <AlertTriangle size={16} />}
            {stats?.hasUpstreamKey ? '上游 Key 已配置' : '缺少 CODING_PLAN_API_KEY'}
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {newSecret && (
          <div className="secret-banner">
            <div>
              <strong>新 proxy key</strong>
              <code>{newSecret}</code>
            </div>
            <button className="ghost-button" onClick={() => void navigator.clipboard.writeText(newSecret)} title="复制">
              <Copy size={16} />
              复制
            </button>
            <button className="icon-button" onClick={() => setNewSecret('')} title="关闭">
              ×
            </button>
          </div>
        )}

        {page === 'dashboard' && stats && (
          <Dashboard stats={stats} keys={keys} officialUsage={officialUsage} refreshOfficialUsage={refreshOfficialUsage} />
        )}
        {page === 'keys' && (
          <KeysPage
            keys={keys}
            users={users}
            userMap={userMap}
            showCreate={showCreate}
            setShowCreate={setShowCreate}
            keyForm={keyForm}
            setKeyForm={setKeyForm}
            createKey={createKey}
            updateKey={updateKey}
            rotateKey={rotateKey}
            deleteKey={deleteKey}
            openCreateKeyForm={openCreateKeyForm}
          />
        )}
        {page === 'usage' && <UsagePage usage={usage} />}
        {page === 'settings' && settings && (
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            saveSettings={saveSettings}
            refreshOfficialUsage={refreshOfficialUsage}
            applyQuotaAllocation={applyQuotaAllocation}
          />
        )}
        {page === 'users' && (
          <UsersPage users={users} keys={keys} api={api} onRefresh={loadAll} />
        )}
      </main>
    </div>
  )
}

function UserApp({ auth, onLogout }: { auth: AuthState; onLogout: () => void }) {
  const [page, setPage] = useState<UserPage>('my-keys')
  const [keys, setKeys] = useState<ProxyKey[]>([])
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [passwordForm, setPasswordForm] = useState({ current: '', newPwd: '', confirm: '' })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('kcp_sidebar_collapsed') === 'true' } catch { return false }
  })

  const toggleSidebar = () => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    try { localStorage.setItem('kcp_sidebar_collapsed', String(next)) } catch {}
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        ...(init.headers || {})
      }
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || response.statusText)
    }
    if (response.status === 204) return null as T
    return response.json() as Promise<T>
  }

  async function loadAll() {
    setLoading(true)
    setNotice('')
    try {
      const [nextKeys, nextStats] = await Promise.all([
        api<ProxyKey[]>('/api/user/keys'),
        api<any>('/api/user/stats')
      ])
      setKeys(nextKeys)
      setStats(nextStats)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [auth.token])

  async function changePassword(event: FormEvent) {
    event.preventDefault()
    if (passwordForm.newPwd !== passwordForm.confirm) {
      setNotice('两次输入的新密码不一致')
      return
    }
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: passwordForm.current,
          newPassword: passwordForm.newPwd
        })
      })
      setNotice('密码修改成功')
      setPasswordForm({ current: '', newPwd: '', confirm: '' })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '修改失败')
    }
  }

  const nav = [
    { id: 'my-keys' as UserPage, label: '我的 Keys', icon: KeyRound },
    { id: 'settings' as UserPage, label: '修改密码', icon: Lock }
  ]

  const selectedTitle = nav.find((item) => item.id === page)?.label || '我的 Keys'

  return (
    <div className={classNames('app-shell', sidebarCollapsed && 'sidebar-collapsed')}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-box">
            <ShieldCheck size={22} />
          </div>
          <div className="sidebar-brand-text">
            <strong>coding-plan-proxy</strong>
            <span>用户面板</span>
          </div>
          <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? '展开' : '收起'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points={sidebarCollapsed ? "9 18 15 12 9 6" : "15 18 9 12 15 6"} />
            </svg>
          </button>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={classNames('nav-item', page === item.id && 'active')}
                onClick={() => setPage(item.id)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-badge">
            <User size={14} />
            <span>{auth.user.username}</span>
          </div>
          <div className="sidebar-actions">
            <button className="ghost-button" onClick={() => void loadAll()} title="刷新">
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
              <span>刷新</span>
            </button>
            <button className="ghost-button logout-btn" onClick={onLogout}>
              <LogOut size={14} />
              <span>退出</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>{selectedTitle}</h1>
            <p>查看你被分配的 proxy key 和额度使用情况。</p>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}

        {page === 'my-keys' && (
          <section className="stack">
            {stats && (
              <div className="card-grid user-stats-grid">
                <article className="metric-card">
                  <div className="metric-icon blue">
                    <KeyRound size={19} />
                  </div>
                  <div>
                    <span>我的 Keys</span>
                    <strong>{keys.length}</strong>
                    <small>已分配</small>
                  </div>
                </article>
                <article className="metric-card">
                  <div className="metric-icon green">
                    <Activity size={19} />
                  </div>
                  <div>
                    <span>今日请求</span>
                    <strong>{fmtNumber(stats.todayRequests)}</strong>
                    <small>累计 {fmtNumber(stats.totalRequests)}</small>
                  </div>
                </article>
                <article className="metric-card">
                  <div className="metric-icon amber">
                    <Gauge size={19} />
                  </div>
                  <div>
                    <span>今日 Tokens</span>
                    <strong>{fmtNumber(stats.todayTokens)}</strong>
                    <small>累计 {fmtNumber(stats.totalTokens)}</small>
                  </div>
                </article>
              </div>
            )}
            {keys.length === 0 ? (
              <div className="panel">
                <p className="muted-text">暂无分配给你的 proxy key。</p>
              </div>
            ) : (
              <div className="key-usage-grid">
                {keys.map((key) => (
                  <article className="usage-card" key={key.id}>
                    <div className="usage-card-title">
                      <strong>{key.name}</strong>
                      <div className="usage-card-badges">
                        <span className="badge neutral">{key.quotaPercent}% 总池</span>
                        <span className={classNames('badge', key.active ? 'active' : 'paused')}>
                          {key.active ? '启用' : '暂停'}
                        </span>
                      </div>
                    </div>
                    <div className="key-preview-row">
                      <code>{key.keyPreview}</code>
                      <button
                        className="icon-button"
                        onClick={() => void navigator.clipboard.writeText(key.secret)}
                        title="复制完整 Key"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                    <QuotaLine label="5h 请求" used={key.usage.fiveHours.requests} limit={key.limits.fiveHours.requests} dynamic={key.dynamicLimits?.fiveHours} />
                    <QuotaLine label="5h Token" used={key.usage.fiveHours.tokens} limit={key.limits.fiveHours.tokens} dynamic={key.dynamicLimits?.fiveHours} isToken />
                    <QuotaLine label="7d 请求" used={key.usage.week.requests} limit={key.limits.week.requests} dynamic={key.dynamicLimits?.week} />
                    <QuotaLine label="7d Token" used={key.usage.week.tokens} limit={key.limits.week.tokens} dynamic={key.dynamicLimits?.week} isToken />
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {page === 'settings' && (
          <form className="panel form-panel" onSubmit={changePassword} style={{ maxWidth: 480 }}>
            <div className="panel-heading">
              <h2>修改密码</h2>
            </div>
            <label>
              当前密码
              <input
                type="password"
                value={passwordForm.current}
                onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })}
                required
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                value={passwordForm.newPwd}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPwd: e.target.value })}
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                value={passwordForm.confirm}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
                required
              />
            </label>
            <button className="primary-button" type="submit">
              <Save size={16} />
              修改密码
            </button>
          </form>
        )}
      </main>
    </div>
  )
}

function Dashboard({
  stats,
  keys,
  officialUsage,
  refreshOfficialUsage
}: {
  stats: Stats
  keys: ProxyKey[]
  officialUsage: OfficialUsage | null
  refreshOfficialUsage: () => Promise<void>
}) {
  const cards = [
    { label: 'Proxy Keys', value: `${stats.activeKeys}/${stats.totalKeys}`, hint: '启用 / 全部', icon: KeyRound, tone: 'blue' },
    { label: '今日请求', value: fmtNumber(stats.todayRequests), hint: `累计 ${fmtNumber(stats.totalRequests)}`, icon: Activity, tone: 'green' },
    { label: '今日 Tokens', value: fmtNumber(stats.todayTokens), hint: `累计 ${fmtNumber(stats.totalTokens)}`, icon: Gauge, tone: 'amber' },
    { label: '平均延迟', value: `${fmtNumber(stats.avgLatency)}ms`, hint: `${fmtNumber(stats.errors)} 次错误`, icon: Clock, tone: 'rose' }
  ]
  return (
    <section className="stack">
      <div className="card-grid">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <article className="metric-card" key={card.label}>
              <div className={`metric-icon ${card.tone}`}>
                <Icon size={19} />
              </div>
              <div>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.hint}</small>
              </div>
            </article>
          )
        })}
      </div>
      <OfficialUsagePanel officialUsage={officialUsage} refreshInfo={stats.refreshInfo} refreshOfficialUsage={refreshOfficialUsage} />
      <section className="panel">
        <div className="panel-heading">
          <h2>成员窗口使用</h2>
          <span>默认每人 {(stats.settings.defaultQuotaPercent ?? 45).toFixed(2)}%，预留 {stats.settings.reservePercent ?? 10}%</span>
        </div>
        <div className="key-usage-grid">
          {keys.map((key) => (
            <article className="usage-card" key={key.id}>
              <div className="usage-card-title">
                <strong>{key.name}</strong>
                <div className="usage-card-badges">
                  <span className="badge neutral">{key.quotaPercent}% 总池</span>
                  <span className={classNames('badge', key.active ? 'active' : 'paused')}>
                    {key.active ? '启用' : '暂停'}
                  </span>
                </div>
              </div>
              <QuotaLine label="5h 请求" used={key.usage.fiveHours.requests} limit={key.limits.fiveHours.requests} dynamic={key.dynamicLimits?.fiveHours} />
              <QuotaLine label="5h Token" used={key.usage.fiveHours.tokens} limit={key.limits.fiveHours.tokens} dynamic={key.dynamicLimits?.fiveHours} isToken />
              <QuotaLine label="7d 请求" used={key.usage.week.requests} limit={key.limits.week.requests} dynamic={key.dynamicLimits?.week} />
              <QuotaLine label="7d Token" used={key.usage.week.tokens} limit={key.limits.week.tokens} dynamic={key.dynamicLimits?.week} isToken />
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}

function OfficialUsagePanel({
  officialUsage,
  refreshInfo,
  refreshOfficialUsage
}: {
  officialUsage: OfficialUsage | null
  refreshInfo: RefreshInfo
  refreshOfficialUsage: () => Promise<void>
}) {
  const ok = officialUsage?.ok
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>官方实时额度</h2>
          <span>
            {refreshInfo.intervalMinutes <= 0
              ? '被动模式：手动刷新 + 429 触发'
              : `自适应刷新：${refreshInfo.intervalMinutes}分钟 / 下次刷新：${fmtCountdown(refreshInfo.nextRefreshInSeconds)}`}
          </span>
        </div>
        <button className="ghost-button" onClick={() => void refreshOfficialUsage()}>
          <RefreshCw size={16} />
          手动刷新
        </button>
      </div>
      {!officialUsage ? (
        <p className="muted-text">尚未刷新。该功能默认关闭，需在设置页启用后才会请求官方 usage 接口。</p>
      ) : ok ? (
        <div className="official-grid">
          <OfficialQuotaCard title="5h 会话窗口" quota={officialUsage.session} />
          <OfficialQuotaCard title="7d 周期窗口" quota={officialUsage.largestWindow} />
          <article className="official-card compact">
            <span>并发上限</span>
            <strong>{officialUsage.parallelLimit ?? '-'}</strong>
            <small>官方 parallel.limit</small>
          </article>
          <article className="official-card compact">
            <span>上次刷新</span>
            <strong>{fmtDate(officialUsage.fetchedAt)}</strong>
            <small>{officialUsage.userAgent || 'CodingPlanProxy/0.1 quota-check'}</small>
          </article>
        </div>
      ) : (
        <div className="official-error">
          <strong>官方额度刷新失败</strong>
          <span>{officialUsage.error || `HTTP ${officialUsage.status || 0}`}</span>
          <small>当前不会伪装成官方客户端；如果官方拒绝该 UA，会保留失败状态供你判断。</small>
        </div>
      )}
    </section>
  )
}

function OfficialQuotaCard({ title, quota }: { title: string; quota?: OfficialQuota | null }) {
  const limit = quota?.limit ?? 0
  const used = quota?.used ?? 0
  const pct = quota?.percentUsed ?? percent(used, limit)
  const health = quota?.health || 'unknown'
  const countdown = quota?.secondsUntilReset ?? null
  return (
    <article className={classNames('official-card', healthClass(health))}>
      <div className="official-card-header">
        <span>{title}</span>
        <span className={classNames('health-dot', healthClass(health))} />
      </div>
      <div className="official-card-body">
        <div className="official-metric">
          <strong>{fmtNumber(used)} / {limit ? fmtNumber(limit) : '-'}</strong>
          <small>封装数据 · 非真实配额</small>
        </div>
        <div className="official-metric secondary">
          <span>{pct}% 显示已用</span>
        </div>
      </div>
      {countdown !== null && countdown > 0 && (
        <div className="official-countdown">
          <Clock size={12} />
          <small>窗口重置：{fmtCountdown(countdown)}后</small>
        </div>
      )}
      <div className="progress">
        <span className={healthClass(health)} style={{ width: `${pct || 0}%` }} />
      </div>
    </article>
  )
}

function QuotaLine({
  label,
  used,
  limit,
  dynamic,
  isToken
}: {
  label: string
  used: number
  limit: number
  dynamic?: DynamicWindow | null
  isToken?: boolean
}) {
  const hasDynamic = dynamic && (
    isToken ? dynamic.tokenDynamicLimit > 0 : dynamic.dynamicLimit > 0
  )
  const dynamicRemaining = hasDynamic
    ? (isToken ? dynamic.tokenRemaining : dynamic.remaining)
    : null
  const displayLimit = hasDynamic
    ? (isToken ? dynamic.tokenDynamicLimit : dynamic.dynamicLimit)
    : limit
  const barPct = percent(used, displayLimit)
  const rawPct = displayLimit > 0 ? Math.round((used / displayLimit) * 100) : 0

  return (
    <div className="quota-line">
      <div>
        <span>{label}</span>
        <small>
          {fmtNumber(used)} / {displayLimit ? fmtNumber(displayLimit) : '不限'} · {rawPct}%
          {hasDynamic && dynamicRemaining !== null && (
            <span className="dynamic-hint">
              {' '}
              · 剩余 {fmtNumber(dynamicRemaining)}
              {isToken && dynamic?.inferredTotal && (
                <span> (推算总量 {fmtNumber(dynamic.inferredTotal)})</span>
              )}
            </span>
          )}
        </small>
      </div>
      <div className="progress">
        <span
          className={classNames(
            hasDynamic && (isToken ? dynamic!.tokenRemaining : dynamic!.remaining) <= 0 && 'health-critical',
            rawPct > 100 && 'health-warning'
          )}
          style={{ width: `${Math.min(100, barPct)}%` }}
        />
      </div>
    </div>
  )
}

function KeysPage(props: {
  keys: ProxyKey[]
  users: User[]
  userMap: Record<string, string>
  showCreate: boolean
  setShowCreate: (value: boolean) => void
  keyForm: typeof defaultKeyForm
  setKeyForm: (value: typeof defaultKeyForm) => void
  createKey: (event: FormEvent) => Promise<void>
  updateKey: (id: string, patch: Partial<ProxyKey>) => Promise<void>
  rotateKey: (id: string) => Promise<void>
  deleteKey: (id: string) => Promise<void>
  openCreateKeyForm: () => void
}) {
  return (
    <section className="stack">
      <div className="toolbar">
        <p>每个人一个 proxy key。真实上游 Key 只留在服务器环境变量里。</p>
        <button className="primary-button" onClick={props.openCreateKeyForm}>
          <Plus size={16} />
          新建 Key
        </button>
      </div>

      {props.showCreate && (
        <KeyForm
          title="新建 proxy key"
          form={props.keyForm}
          setForm={props.setKeyForm}
          onSubmit={props.createKey}
          onCancel={() => props.setShowCreate(false)}
          users={props.users}
        />
      )}

      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>Key</th>
              <th>分配给</th>
              <th>占总池</th>
              <th>5h 请求/Token</th>
              <th>7d 请求/Token</th>
              <th>并发</th>
              <th>最近使用</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {props.keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <input
                    className="table-input"
                    defaultValue={key.name}
                    onBlur={(event) => void props.updateKey(key.id, { name: event.target.value })}
                  />
                </td>
                <td>
                  <div className="key-secret-row">
                    <code>{key.keyPreview}</code>
                    <button
                      className="icon-button"
                      onClick={() => void navigator.clipboard.writeText(key.secret)}
                      title="复制完整 Key"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </td>
                <td>
                  <select
                    className="table-input"
                    value={key.assignedToUserId || ''}
                    onChange={(event) => void props.updateKey(key.id, { assignedToUserId: event.target.value || null })}
                  >
                    <option value="">未分配</option>
                    {props.users.map((u) => (
                      <option key={u.id} value={u.id}>{u.username}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="quota-input"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={key.quotaPercent}
                    onBlur={(event) => void props.updateKey(key.id, { quotaPercent: Number(event.target.value) })}
                  />
                  %
                </td>
                <td>
                  {key.percentages.fiveHours.requests}% / {key.percentages.fiveHours.tokens}%
                </td>
                <td>
                  {key.percentages.week.requests}% / {key.percentages.week.tokens}%
                </td>
                <td>{key.concurrencyLimit}</td>
                <td>{fmtDate(key.lastUsedAt)}</td>
                <td>
                  <button
                    className={classNames('badge-button', key.active ? 'active' : 'paused')}
                    onClick={() => void props.updateKey(key.id, { active: !key.active })}
                  >
                    <PauseCircle size={14} />
                    {key.active ? '启用' : '暂停'}
                  </button>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="icon-button" onClick={() => void props.rotateKey(key.id)} title="轮换 Key">
                      <RotateCcw size={15} />
                    </button>
                    <button className="icon-button danger" onClick={() => void props.deleteKey(key.id)} title="删除">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function KeyForm({
  title,
  form,
  setForm,
  onSubmit,
  onCancel,
  users
}: {
  title: string
  form: typeof defaultKeyForm
  setForm: (value: typeof defaultKeyForm) => void
  onSubmit: (event: FormEvent) => Promise<void>
  onCancel: () => void
  users: User[]
}) {
  const update = (patch: Partial<typeof defaultKeyForm>) => setForm({ ...form, ...patch })
  return (
    <form className="panel form-panel" onSubmit={(event) => void onSubmit(event)}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <span>默认使用设置页的"人数 / 预留比例"计算出的每人占比。</span>
      </div>
      <div className="form-grid">
        <label>
          名称
          <input value={form.name} onChange={(event) => update({ name: event.target.value })} required />
        </label>
        <label>
          分配给普通用户
          <select value={form.assignedToUserId} onChange={(event) => update({ assignedToUserId: event.target.value })}>
            <option value="">未分配</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.username}</option>
            ))}
          </select>
        </label>
        <label>
          占总池比例 %
          <input
            type="number"
            min={0}
            max={100}
            value={form.quotaPercent}
            onChange={(event) => update({ quotaPercent: Number(event.target.value) })}
          />
        </label>
        <label>
          并发上限
          <input
            type="number"
            value={form.concurrencyLimit}
            onChange={(event) => update({ concurrencyLimit: Number(event.target.value) })}
          />
        </label>
      </div>
      <label>
        备注
        <textarea value={form.notes} onChange={(event) => update({ notes: event.target.value })} />
      </label>
      <div className="form-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>
          取消
        </button>
        <button className="primary-button" type="submit">
          <Save size={16} />
          创建
        </button>
      </div>
    </form>
  )
}

function UsagePage({ usage }: { usage: UsageEntry[] }) {
  return (
    <section className="panel table-panel">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>成员</th>
            <th>状态</th>
            <th>模型</th>
            <th>Tokens</th>
            <th>延迟</th>
            <th>User-Agent</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((item) => (
            <tr key={item.id}>
              <td>{fmtDate(item.createdAt)}</td>
              <td>{item.keyName}</td>
              <td>
                <span className={classNames('status-code', item.status >= 400 ? 'bad' : 'good')}>{item.status}</span>
              </td>
              <td>{item.model || '-'}</td>
              <td>{fmtNumber(item.totalTokens)}</td>
              <td>{item.latencyMs}ms</td>
              <td className="ua-cell" title={item.userAgent}>
                {item.userAgent || '-'}
              </td>
              <td>{item.errorCode || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function SettingsPage({
  settings,
  setSettings,
  saveSettings,
  refreshOfficialUsage,
  applyQuotaAllocation
}: {
  settings: SettingsState
  setSettings: (value: SettingsState) => void
  saveSettings: (event: FormEvent) => Promise<void>
  refreshOfficialUsage: () => Promise<void>
  applyQuotaAllocation: () => Promise<void>
}) {
  const applyPreset = (preset: keyof typeof quotaPresets) => {
    const { label, ...values } = quotaPresets[preset]
    setSettings({ ...settings, ...values })
  }

  return (
    <section className="settings-grid">
      <form className="panel form-panel" onSubmit={(event) => void saveSettings(event)}>
        <div className="panel-heading">
          <h2>代理设置</h2>
          <span>上游 Key 只从服务端环境变量读取，不在面板里展示。</span>
        </div>
        <label>
          上游 Base URL
          <input
            value={settings.upstreamBaseUrl}
            onChange={(event) => setSettings({ ...settings, upstreamBaseUrl: event.target.value })}
          />
        </label>
        <div className="form-grid">
          <label>
            全局并发上限
            <input
              type="number"
              value={settings.globalConcurrencyLimit}
              onChange={(event) => setSettings({ ...settings, globalConcurrencyLimit: Number(event.target.value) })}
            />
          </label>
          <label>
            日志保留天数
            <input
              type="number"
              value={settings.keepUsageDays}
              onChange={(event) => setSettings({ ...settings, keepUsageDays: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="panel-heading compact-heading">
          <h2>官方额度检查</h2>
          <span>使用服务端 CODING_PLAN_API_KEY 请求官方 usage 接口。</span>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.quotaCheckEnabled}
            onChange={(event) => setSettings({ ...settings, quotaCheckEnabled: event.target.checked })}
          />
          启用官方额度检查
        </label>
        <div className="form-grid">
          <label>
            自动刷新间隔分钟（0 = 禁用定时刷新）
            <input
              type="number"
              min={0}
              value={settings.quotaCheckIntervalMinutes}
              onChange={(event) => setSettings({ ...settings, quotaCheckIntervalMinutes: Number(event.target.value) })}
            />
          </label>
          <label>
            额度检查 User-Agent
            <input
              value={settings.quotaCheckUserAgent}
              onChange={(event) => setSettings({ ...settings, quotaCheckUserAgent: event.target.value })}
            />
          </label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.quotaCheckOn429}
            onChange={(event) => setSettings({ ...settings, quotaCheckOn429: event.target.checked })}
          />
          上游返回 429 时自动刷新官方额度（被动触发）
        </label>
        <div className="preset-row">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void refreshOfficialUsage()}
            disabled={!settings.quotaCheckEnabled}
          >
            <RefreshCw size={16} />
            手动刷新官方额度
          </button>
        </div>
        <p className="muted-text">
          当前身份：{settings.quotaCheckUserAgent || 'CodingPlanProxy/0.1 quota-check'}。
          {settings.quotaCheckIntervalMinutes > 0
            ? `定时刷新每 ${settings.quotaCheckIntervalMinutes} 分钟一次。`
            : '定时刷新已禁用，仅通过手动刷新和 429 被动触发查询官方额度。'}
        </p>
        <div className="panel-heading compact-heading">
          <h2>额度分配</h2>
          <span>每人默认占比 = (100% - 预留%) / 人数。</span>
        </div>
        <div className="form-grid">
          <label>
            人数
            <input
              type="number"
              min={1}
              value={settings.memberCount}
              onChange={(event) => setSettings({ ...settings, memberCount: Number(event.target.value) })}
            />
          </label>
          <label>
            预留比例 %
            <input
              type="number"
              min={0}
              max={100}
              value={settings.reservePercent}
              onChange={(event) => setSettings({ ...settings, reservePercent: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="allocation-summary">
          <div>
            <span>当前每人默认占比</span>
            <strong>{(((100 - settings.reservePercent) / Math.max(1, settings.memberCount)) || 0).toFixed(2)}%</strong>
          </div>
          <button type="button" className="ghost-button" onClick={() => void applyQuotaAllocation()}>
            应用到所有 Key
          </button>
        </div>
        <div className="panel-heading compact-heading">
          <h2>官方同步策略</h2>
          <span>官方百分比只用于动态估算 token 总池，预设请求上限仍作为硬限制。</span>
        </div>
        <label>
          外部消耗权重（0-1）
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.externalUsageWeight}
            onChange={(event) => setSettings({ ...settings, externalUsageWeight: Number(event.target.value) })}
          />
        </label>
        <p className="muted-text">
          官方同步会按刷新时的已用百分比估算本周期 token 总池；若官方消耗明显高于代理日志，差额先消耗预留池，再按权重压缩所有人的剩余额度。
        </p>
        <div className="panel-heading compact-heading">
          <h2>账号总池</h2>
          <span>每个 proxy key 的硬上限 = 总池 × 占比。</span>
        </div>
        <div className="preset-row">
          <button type="button" className="ghost-button" onClick={() => applyPreset('allegretto')}>
            Allegretto 预设
          </button>
          <button type="button" className="ghost-button" onClick={() => applyPreset('andante')}>
            Andante 预设
          </button>
        </div>
        <div className="form-grid">
          <label>
            5h 总请求
            <input
              type="number"
              value={settings.totalFiveHourRequestLimit}
              onChange={(event) => setSettings({ ...settings, totalFiveHourRequestLimit: Number(event.target.value) })}
            />
          </label>
          <label>
            5h 总 Token
            <input
              type="number"
              value={settings.totalFiveHourTokenLimit}
              onChange={(event) => setSettings({ ...settings, totalFiveHourTokenLimit: Number(event.target.value) })}
            />
          </label>
          <label>
            7d 总请求
            <input
              type="number"
              value={settings.totalWeeklyRequestLimit}
              onChange={(event) => setSettings({ ...settings, totalWeeklyRequestLimit: Number(event.target.value) })}
            />
          </label>
          <label>
            7d 总 Token
            <input
              type="number"
              value={settings.totalWeeklyTokenLimit}
              onChange={(event) => setSettings({ ...settings, totalWeeklyTokenLimit: Number(event.target.value) })}
            />
          </label>
        </div>
        <button className="primary-button" type="submit">
          <Save size={16} />
          保存设置
        </button>
      </form>
      <article className="panel policy-panel">
        <h2>使用边界</h2>
        <p>代理会透传客户端原始 User-Agent，仅替换上游 Authorization。请把客户端 Base URL 配到：</p>
        <code>{window.location.origin}/v1</code>
      </article>
    </section>
  )
}

function UsersPage({
  users,
  keys,
  api,
  onRefresh
}: {
  users: User[]
  keys: ProxyKey[]
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  onRefresh: () => Promise<void>
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', role: 'user' as UserRole })
  const [notice, setNotice] = useState('')

  async function createUser(event: FormEvent) {
    event.preventDefault()
    setNotice('')
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(form)
      })
      setShowCreate(false)
      setForm({ username: '', password: '', role: 'user' })
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建失败')
    }
  }

  async function deleteUser(id: string) {
    if (!confirm('确认删除这个用户？其关联的 key 将变为未分配。')) return
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' })
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    }
  }

  async function resetPassword(id: string) {
    const newPassword = prompt('输入新密码：')
    if (!newPassword) return
    try {
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: newPassword })
      })
      await onRefresh()
      setNotice('密码已重置')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重置失败')
    }
  }

  const keyCountByUser = useMemo(() => {
    const map: Record<string, number> = {}
    for (const key of keys) {
      if (key.assignedToUserId) {
        map[key.assignedToUserId] = (map[key.assignedToUserId] || 0) + 1
      }
    }
    return map
  }, [keys])

  return (
    <section className="stack">
      <div className="toolbar">
        <p>管理普通用户和管理员。创建后把账号密码发给对应成员。</p>
        <button className="primary-button" onClick={() => setShowCreate(true)}>
          <Plus size={16} />
          新建用户
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      {showCreate && (
        <form className="panel form-panel" onSubmit={(event) => void createUser(event)}>
          <div className="panel-heading">
            <h2>新建用户</h2>
          </div>
          <div className="form-grid">
            <label>
              用户名
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            </label>
            <label>
              密码
              <input
                type="text"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </label>
            <label>
              角色
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="ghost-button" onClick={() => setShowCreate(false)}>
              取消
            </button>
            <button className="primary-button" type="submit">
              <Save size={16} />
              创建
            </button>
          </div>
        </form>
      )}

      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>分配 Key 数</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.username}</strong></td>
                <td>
                  <span className={classNames('badge', u.role === 'admin' ? 'active' : 'neutral')}>
                    {u.role === 'admin' ? '管理员' : '普通用户'}
                  </span>
                </td>
                <td>{keyCountByUser[u.id] || 0}</td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    <button className="ghost-button" onClick={() => resetPassword(u.id)} title="重置密码">
                      <Lock size={14} />
                      重置密码
                    </button>
                    <button className="icon-button danger" onClick={() => deleteUser(u.id)} title="删除">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
