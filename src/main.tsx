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
  PauseCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  Users
} from 'lucide-react'
import './styles.css'

type Page = 'dashboard' | 'keys' | 'usage' | 'settings'

type UsageWindow = {
  requests: number
  tokens: number
  errors: number
}

type QuotaWindow = {
  requests: number
  tokens: number
}

type ProxyKey = {
  id: string
  name: string
  keyPreview: string
  active: boolean
  quotaPercent: number
  concurrencyLimit: number
  notes: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  usage: {
    fiveHours: UsageWindow
    week: UsageWindow
    month: UsageWindow
  }
  limits: {
    fiveHours: QuotaWindow
    week: QuotaWindow
    month: QuotaWindow
  }
  percentages: {
    fiveHours: QuotaWindow
    week: QuotaWindow
    month: QuotaWindow
  }
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
  totalFiveHourRequestLimit: number
  totalWeeklyRequestLimit: number
  totalMonthlyRequestLimit: number
  totalFiveHourTokenLimit: number
  totalWeeklyTokenLimit: number
  totalMonthlyTokenLimit: number
  hasUpstreamKey?: boolean
}

const defaultKeyForm = {
  name: '',
  active: true,
  quotaPercent: 45,
  concurrencyLimit: 1,
  notes: ''
}

const quotaPresets = {
  andante: {
    label: 'Kimi Code Andante',
    totalFiveHourRequestLimit: 359,
    totalWeeklyRequestLimit: 639,
    totalMonthlyRequestLimit: 2556,
    totalFiveHourTokenLimit: 15000000,
    totalWeeklyTokenLimit: 21000000,
    totalMonthlyTokenLimit: 84000000
  },
  allegretto: {
    label: 'Kimi Code Allegretto',
    totalFiveHourRequestLimit: 1307,
    totalWeeklyRequestLimit: 9073,
    totalMonthlyRequestLimit: 36292,
    totalFiveHourTokenLimit: 65000000,
    totalWeeklyTokenLimit: 357000000,
    totalMonthlyTokenLimit: 1428000000
  }
} as const

function readAdminToken() {
  return localStorage.getItem('kimi_proxy_admin_token') || ''
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

function classNames(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(' ')
}

function App() {
  const [token, setToken] = useState(readAdminToken())
  const [tokenDraft, setTokenDraft] = useState(readAdminToken())
  const [page, setPage] = useState<Page>('dashboard')
  const [stats, setStats] = useState<Stats | null>(null)
  const [keys, setKeys] = useState<ProxyKey[]>([])
  const [usage, setUsage] = useState<UsageEntry[]>([])
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [keyForm, setKeyForm] = useState(defaultKeyForm)

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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
    if (!token) return
    setLoading(true)
    setNotice('')
    try {
      const [nextStats, nextKeys, nextUsage, nextSettings] = await Promise.all([
        api<Stats>('/api/admin/stats'),
        api<ProxyKey[]>('/api/admin/keys'),
        api<UsageEntry[]>('/api/admin/usage?limit=150'),
        api<SettingsState>('/api/admin/settings')
      ])
      setStats(nextStats)
      setKeys(nextKeys)
      setUsage(nextUsage)
      setSettings(nextSettings)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [token])

  const nav = [
    { id: 'dashboard' as Page, label: '总览', icon: BarChart3 },
    { id: 'keys' as Page, label: 'Proxy Keys', icon: KeyRound },
    { id: 'usage' as Page, label: '审计日志', icon: Activity },
    { id: 'settings' as Page, label: '设置', icon: Settings }
  ]

  function saveToken(event: FormEvent) {
    event.preventDefault()
    localStorage.setItem('kimi_proxy_admin_token', tokenDraft)
    setToken(tokenDraft)
  }

  async function createKey(event: FormEvent) {
    event.preventDefault()
    const created = await api<{ key: ProxyKey; secret: string }>('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify(keyForm)
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

  const selectedTitle = useMemo(() => nav.find((item) => item.id === page)?.label || '总览', [page])

  if (!token) {
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={saveToken}>
          <div className="brand-mark">
            <ShieldCheck size={28} />
          </div>
          <h1>Kimi Thin Proxy</h1>
          <p>输入服务端 `ADMIN_TOKEN` 后管理内部 proxy key、限额和审计日志。</p>
          <label>
            Admin Token
            <input
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="change-this-admin-token"
              type="password"
            />
          </label>
          <button className="primary-button" type="submit">
            <Lock size={16} />
            进入面板
          </button>
        </form>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-box">
            <ShieldCheck size={22} />
          </div>
          <div>
            <strong>Kimi Thin Proxy</strong>
            <span>internal quota gateway</span>
          </div>
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
          <button className="ghost-button" onClick={() => void loadAll()} title="刷新">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            刷新
          </button>
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
            {stats?.hasUpstreamKey ? '上游 Key 已配置' : '缺少 KIMI_API_KEY'}
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {newSecret && (
          <div className="secret-banner">
            <div>
              <strong>新 proxy key 只显示一次</strong>
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

        {page === 'dashboard' && stats && <Dashboard stats={stats} keys={keys} />}
        {page === 'keys' && (
          <KeysPage
            keys={keys}
            showCreate={showCreate}
            setShowCreate={setShowCreate}
            keyForm={keyForm}
            setKeyForm={setKeyForm}
            createKey={createKey}
            updateKey={updateKey}
            rotateKey={rotateKey}
            deleteKey={deleteKey}
          />
        )}
        {page === 'usage' && <UsagePage usage={usage} />}
        {page === 'settings' && settings && (
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            saveSettings={saveSettings}
            tokenDraft={tokenDraft}
            setTokenDraft={setTokenDraft}
            saveToken={saveToken}
          />
        )}
      </main>
    </div>
  )
}

function Dashboard({ stats, keys }: { stats: Stats; keys: ProxyKey[] }) {
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
      <section className="panel">
        <div className="panel-heading">
          <h2>成员窗口使用</h2>
          <span>每个 key 按总池的 45% 这类比例计算硬上限</span>
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
              <QuotaLine label="5h 请求" used={key.usage.fiveHours.requests} limit={key.limits.fiveHours.requests} />
              <QuotaLine label="5h Token" used={key.usage.fiveHours.tokens} limit={key.limits.fiveHours.tokens} />
              <QuotaLine label="7d 请求" used={key.usage.week.requests} limit={key.limits.week.requests} />
              <QuotaLine label="7d Token" used={key.usage.week.tokens} limit={key.limits.week.tokens} />
              <QuotaLine label="30d 请求" used={key.usage.month.requests} limit={key.limits.month.requests} />
              <QuotaLine label="30d Token" used={key.usage.month.tokens} limit={key.limits.month.tokens} />
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}

function QuotaLine({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="quota-line">
      <div>
        <span>{label}</span>
        <small>
          {fmtNumber(used)} / {limit ? fmtNumber(limit) : '不限'} · {percent(used, limit)}%
        </small>
      </div>
      <div className="progress">
        <span style={{ width: `${percent(used, limit)}%` }} />
      </div>
    </div>
  )
}

function KeysPage(props: {
  keys: ProxyKey[]
  showCreate: boolean
  setShowCreate: (value: boolean) => void
  keyForm: typeof defaultKeyForm
  setKeyForm: (value: typeof defaultKeyForm) => void
  createKey: (event: FormEvent) => Promise<void>
  updateKey: (id: string, patch: Partial<ProxyKey>) => Promise<void>
  rotateKey: (id: string) => Promise<void>
  deleteKey: (id: string) => Promise<void>
}) {
  return (
    <section className="stack">
      <div className="toolbar">
        <p>每个人一个 proxy key。真实 Kimi Key 只留在服务器环境变量里。</p>
        <button className="primary-button" onClick={() => props.setShowCreate(true)}>
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
        />
      )}

      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>Key</th>
              <th>占总池</th>
              <th>5h 请求/Token</th>
              <th>7d 请求/Token</th>
              <th>30d 请求/Token</th>
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
                  <code>{key.keyPreview}</code>
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
                <td>
                  {key.percentages.month.requests}% / {key.percentages.month.tokens}%
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
  onCancel
}: {
  title: string
  form: typeof defaultKeyForm
  setForm: (value: typeof defaultKeyForm) => void
  onSubmit: (event: FormEvent) => Promise<void>
  onCancel: () => void
}) {
  const update = (patch: Partial<typeof defaultKeyForm>) => setForm({ ...form, ...patch })
  return (
    <form className="panel form-panel" onSubmit={(event) => void onSubmit(event)}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <span>默认每人 45%，两人合计 90%，保留 10% 缓冲。</span>
      </div>
      <div className="form-grid">
        <label>
          名称
          <input value={form.name} onChange={(event) => update({ name: event.target.value })} required />
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
  tokenDraft,
  setTokenDraft,
  saveToken
}: {
  settings: SettingsState
  setSettings: (value: SettingsState) => void
  saveSettings: (event: FormEvent) => Promise<void>
  tokenDraft: string
  setTokenDraft: (value: string) => void
  saveToken: (event: FormEvent) => void
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
          Kimi 上游 Base URL
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
          <label>
            30d 总请求
            <input
              type="number"
              value={settings.totalMonthlyRequestLimit}
              onChange={(event) => setSettings({ ...settings, totalMonthlyRequestLimit: Number(event.target.value) })}
            />
          </label>
          <label>
            30d 总 Token
            <input
              type="number"
              value={settings.totalMonthlyTokenLimit}
              onChange={(event) => setSettings({ ...settings, totalMonthlyTokenLimit: Number(event.target.value) })}
            />
          </label>
        </div>
        <button className="primary-button" type="submit">
          <Save size={16} />
          保存设置
        </button>
      </form>
      <form className="panel form-panel" onSubmit={saveToken}>
        <div className="panel-heading">
          <h2>本机面板 Token</h2>
          <span>保存在浏览器 localStorage，用于调用管理接口。</span>
        </div>
        <label>
          Admin Token
          <input value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} type="password" />
        </label>
        <button className="ghost-button" type="submit">
          更新本机 Token
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

createRoot(document.getElementById('root')!).render(<App />)
