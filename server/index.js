import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { ConcurrencyGate, checkRollingLimits } from './limits.js'
import { buildForwardHeaders, estimateTokens, extractBearer, pickModel, pipeUpstreamResponse, sanitizeSchema, upstreamUrl } from './proxy.js'
import { fetchOfficialUsage } from './officialUsage.js'
import { hashPassword, verifyPassword, createToken, requireAuth, requireAdmin } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const port = Number(process.env.PORT || 8787)
const upstreamKey = process.env.KIMI_API_KEY || ''
const store = new Store(path.resolve(rootDir, process.env.DATA_FILE || './data/store.json'))
const gate = new ConcurrencyGate()
let lastOfficialAutoRefreshAt = 0

await store.load()

// Bootstrap default admin if no admins exist
const hasAdmin = store.data.users.some((u) => u.role === 'admin')
if (!hasAdmin) {
  const adminPassword = process.env.ADMIN_TOKEN || 'change-this-admin-token'
  await store.createUser({
    username: 'admin',
    passwordHash: await hashPassword(adminPassword),
    role: 'admin'
  })
  console.log(`Created default admin user: admin / ${adminPassword}`)
}

const app = express()
app.disable('x-powered-by')

app.use('/api', express.json({ limit: '2mb' }))

function dashboardStats() {
  const keys = store.listKeys()
  const usage = store.recentUsage(10000)
  const todayPrefix = new Date().toISOString().slice(0, 10)
  const today = usage.filter((item) => item.createdAt.startsWith(todayPrefix))
  const totalTokens = usage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0)
  const todayTokens = today.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0)
  const errors = usage.filter((item) => item.status >= 400).length
  const avgLatency = usage.length
    ? Math.round(usage.reduce((sum, item) => sum + Number(item.latencyMs || 0), 0) / usage.length)
    : 0
  return {
    totalKeys: keys.length,
    activeKeys: keys.filter((key) => key.active).length,
    todayRequests: today.length,
    totalRequests: usage.length,
    todayTokens,
    totalTokens,
    errors,
    avgLatency,
    concurrency: gate.snapshot(),
    hasUpstreamKey: Boolean(upstreamKey),
    officialUsage: store.data.officialUsage,
    settings: { ...store.data.settings, defaultQuotaPercent: store.defaultQuotaPercent() }
  }
}

async function refreshOfficialUsage() {
  const result = await fetchOfficialUsage({
    token: upstreamKey,
    userAgent: store.data.settings.quotaCheckUserAgent || 'KimiThinProxy/0.1 quota-check'
  })
  await store.recordOfficialUsage(result)
  return result
}

// ========== Public routes ==========

app.get('/health', (_req, res) => {
  res.json({ ok: true, hasUpstreamKey: Boolean(upstreamKey), defaultQuotaPercent: store.defaultQuotaPercent(), settings: store.data.settings })
})

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {}
  const user = store.getUserByUsername(String(username || ''))
  if (!user) {
    res.status(401).json({ error: 'invalid_credentials' })
    return
  }
  const valid = await verifyPassword(String(password || ''), user.passwordHash)
  if (!valid) {
    res.status(401).json({ error: 'invalid_credentials' })
    return
  }
  const token = await createToken(user)
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

// ========== Authenticated routes ==========

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = store.getUser(req.user.sub)
  if (!user) {
    res.status(401).json({ error: 'user_not_found' })
    return
  }
  res.json({ id: user.id, username: user.username, role: user.role })
})

app.post('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  const user = store.getUser(req.user.sub)
  if (!user) {
    res.status(401).json({ error: 'user_not_found' })
    return
  }
  const valid = await verifyPassword(String(currentPassword || ''), user.passwordHash)
  if (!valid) {
    res.status(403).json({ error: 'invalid_current_password' })
    return
  }
  await store.updateUser(user.id, { passwordHash: await hashPassword(String(newPassword || '')) })
  res.json({ ok: true })
})

// ========== User routes (any authenticated user) ==========

app.get('/api/user/keys', requireAuth, (req, res) => {
  const keys = store.listKeysForUser(req.user.sub).map((key) => ({
    ...key,
    ...store.usageReport(key)
  }))
  res.json(keys)
})

app.get('/api/user/stats', requireAuth, (req, res) => {
  const keys = store.listKeysForUser(req.user.sub)
  const usage = store.recentUsage(10000)
  const todayPrefix = new Date().toISOString().slice(0, 10)
  const today = usage.filter((item) => item.createdAt.startsWith(todayPrefix))
  const keyIds = new Set(keys.map((k) => k.id))
  const myUsage = usage.filter((item) => keyIds.has(item.keyId))
  const myToday = today.filter((item) => keyIds.has(item.keyId))
  const totalTokens = myUsage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0)
  const todayTokens = myToday.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0)
  res.json({
    keys: keys.map((key) => ({ ...key, ...store.usageReport(key) })),
    todayRequests: myToday.length,
    totalRequests: myUsage.length,
    todayTokens,
    totalTokens
  })
})

// ========== Admin routes ==========

app.get('/api/admin/stats', requireAuth, requireAdmin, (_req, res) => {
  res.json(dashboardStats())
})

app.get('/api/admin/keys', requireAuth, requireAdmin, (_req, res) => {
  const keys = store.data.keys.map((key) => ({ ...store.publicKey(key), ...store.usageReport(key) }))
  res.json(keys)
})

app.post('/api/admin/keys', requireAuth, requireAdmin, async (req, res) => {
  const created = await store.createKey(req.body || {})
  res.status(201).json(created)
})

app.patch('/api/admin/keys/:id', requireAuth, requireAdmin, async (req, res) => {
  const key = await store.updateKey(req.params.id, req.body || {})
  if (!key) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.json(key)
})

app.post('/api/admin/keys/:id/rotate', requireAuth, requireAdmin, async (req, res) => {
  const rotated = await store.rotateKey(req.params.id)
  if (!rotated) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.json(rotated)
})

app.delete('/api/admin/keys/:id', requireAuth, requireAdmin, async (req, res) => {
  const deleted = await store.deleteKey(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.status(204).end()
})

app.get('/api/admin/usage', requireAuth, requireAdmin, (req, res) => {
  res.json(store.recentUsage(req.query.limit || 100))
})

app.get('/api/admin/settings', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ...store.data.settings, defaultQuotaPercent: store.defaultQuotaPercent(), hasUpstreamKey: Boolean(upstreamKey) })
})

app.patch('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const settings = await store.updateSettings(req.body || {})
  res.json({ ...settings, defaultQuotaPercent: store.defaultQuotaPercent(), hasUpstreamKey: Boolean(upstreamKey) })
})

app.post('/api/admin/quota-allocation/apply', requireAuth, requireAdmin, async (_req, res) => {
  const result = await store.applyQuotaAllocation()
  res.json(result)
})

app.get('/api/admin/official-usage', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    quotaCheckEnabled: store.data.settings.quotaCheckEnabled,
    quotaCheckIntervalMinutes: store.data.settings.quotaCheckIntervalMinutes,
    quotaCheckUserAgent: store.data.settings.quotaCheckUserAgent,
    hasUpstreamKey: Boolean(upstreamKey),
    data: store.data.officialUsage
  })
})

app.post('/api/admin/official-usage/refresh', requireAuth, requireAdmin, async (_req, res) => {
  if (!store.data.settings.quotaCheckEnabled) {
    res.status(409).json({
      ok: false,
      status: 409,
      error: 'official_quota_check_disabled',
      fetchedAt: new Date().toISOString()
    })
    return
  }
  const result = await refreshOfficialUsage()
  res.status(result.ok ? 200 : 502).json(result)
})

app.post('/api/admin/official-usage/sync-totals', requireAuth, requireAdmin, async (_req, res) => {
  if (!store.data.settings.quotaCheckEnabled) {
    res.status(409).json({ error: 'official_quota_check_disabled' })
    return
  }
  const official = store.data.officialUsage
  if (!official?.ok) {
    res.status(400).json({ error: 'official_usage_unavailable' })
    return
  }

  const patch = {}
  if (official.session?.limit) patch.totalFiveHourRequestLimit = official.session.limit
  if (official.weekly?.limit) patch.totalWeeklyRequestLimit = official.weekly.limit
  const settings = await store.updateSettings(patch)
  res.json({ ...settings, defaultQuotaPercent: store.defaultQuotaPercent(), applied: patch })
})

// ========== User management routes (admin only) ==========

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(store.listUsers())
})

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {}
  const trimmed = String(username || '').trim()
  if (!trimmed || !password) {
    res.status(400).json({ error: 'username_and_password_required' })
    return
  }
  if (store.getUserByUsername(trimmed)) {
    res.status(409).json({ error: 'username_exists' })
    return
  }
  const created = await store.createUser({
    username: trimmed,
    passwordHash: await hashPassword(String(password)),
    role: role === 'admin' ? 'admin' : 'user'
  })
  res.status(201).json(created)
})

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { username, role, password } = req.body || {}
  const user = store.getUser(req.params.id)
  if (!user) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }
  const patch = {}
  if (username !== undefined) patch.username = String(username).trim()
  if (role !== undefined) patch.role = role
  if (password !== undefined && password !== '') {
    patch.passwordHash = await hashPassword(String(password))
  }
  const updated = await store.updateUser(req.params.id, patch)
  res.json(updated)
})

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const deleted = await store.deleteUser(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }
  res.status(204).end()
})

// ========== Proxy routes ==========

app.use('/v1', express.raw({ type: '*/*', limit: '50mb' }))

app.all('/v1/*', async (req, res) => {
  const started = Date.now()
  const proxySecret = extractBearer(req)
  const key = store.findKeyBySecret(proxySecret)
  const userAgent = req.get('user-agent') || ''
  let requestBody = null
  let requestText = ''
  let status = 500
  let model = ''
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let errorCode = ''

  if (!key || !key.active) {
    res.status(401).json({ error: key ? 'proxy_key_disabled' : 'proxy_key_invalid' })
    return
  }

  try {
    requestText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    if (requestText && (req.get('content-type') || '').includes('json')) {
      requestBody = JSON.parse(requestText)
      model = pickModel(requestBody)
      inputTokens = estimateTokens(requestBody)
      // Kimi Anthropic-compatible endpoint does not recognize kimi-for-coding
      if (requestBody && requestBody.model === 'kimi-for-coding') {
        requestBody.model = 'claude-sonnet-4-6'
      }
      // Strip conflicting description keywords alongside $ref in tool schemas (moonshot strict check)
      if (requestBody && Array.isArray(requestBody.tools)) {
        for (const tool of requestBody.tools) {
          if (tool.function && tool.function.parameters) {
            tool.function.parameters = sanitizeSchema(tool.function.parameters)
          }
        }
      }
      requestText = JSON.stringify(requestBody)
    }
  } catch {
    requestBody = null
  }

  if (!upstreamKey) {
    status = 503
    errorCode = 'kimi_upstream_key_missing'
    await store.recordUsage({
      keyId: key.id,
      keyName: key.name,
      path: req.path,
      method: req.method,
      model,
      status,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      userAgent,
      errorCode
    })
    res.status(503).json({ error: errorCode })
    return
  }

  const rolling = checkRollingLimits(store, key)
  if (!rolling.ok) {
    status = 429
    errorCode = rolling.reason
    await store.recordUsage({
      keyId: key.id,
      keyName: key.name,
      path: req.path,
      method: req.method,
      model,
      status,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      userAgent,
      errorCode
    })
    res.status(429).json({ error: rolling.reason, used: rolling.used, limit: rolling.limit })
    return
  }

  const globalLimit = Number(store.data.settings.globalConcurrencyLimit || 1)
  const concurrency = gate.canEnter(key.id, Number(key.concurrencyLimit || 1), globalLimit)
  if (!concurrency.ok) {
    status = 429
    errorCode = concurrency.reason
    await store.recordUsage({
      keyId: key.id,
      keyName: key.name,
      path: req.path,
      method: req.method,
      model,
      status,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      userAgent,
      errorCode
    })
    res.status(429).json({ error: concurrency.reason })
    return
  }

  gate.enter(key.id)
  try {
    const responseChunks = []
    const target = upstreamUrl(store.data.settings.upstreamBaseUrl, req)
    const upstreamResponse = await fetch(target, {
      method: req.method,
      headers: buildForwardHeaders(req, upstreamKey),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body
    })
    status = upstreamResponse.status
    const contentType = upstreamResponse.headers.get('content-type') || ''
    await pipeUpstreamResponse(upstreamResponse, res, (chunk) => {
      if (contentType.includes('json') && responseChunks.reduce((sum, item) => sum + item.length, 0) < 2_000_000) {
        responseChunks.push(Buffer.from(chunk))
      }
    })

    if (responseChunks.length) {
      try {
        const parsed = JSON.parse(Buffer.concat(responseChunks).toString('utf8'))
        console.log('[upstream]', req.path, status, JSON.stringify(parsed).slice(0, 800))
        if (parsed.usage) {
          inputTokens = Number(parsed.usage.prompt_tokens || parsed.usage.input_tokens || inputTokens || 0)
          outputTokens = Number(parsed.usage.completion_tokens || parsed.usage.output_tokens || 0)
          totalTokens = Number(parsed.usage.total_tokens || inputTokens + outputTokens)
        }
        if (parsed.error) errorCode = parsed.error.code || parsed.error.type || parsed.error.message || ''
      } catch {
        totalTokens = inputTokens
      }
    } else {
      totalTokens = inputTokens
    }
  } catch (error) {
    status = 502
    errorCode = 'upstream_fetch_failed'
    if (!res.headersSent) res.status(502).json({ error: errorCode, message: error.message })
  } finally {
    gate.leave(key.id)
    await store.recordUsage({
      keyId: key.id,
      keyName: key.name,
      path: req.path,
      method: req.method,
      model,
      status,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
      totalTokens: totalTokens || inputTokens,
      userAgent,
      errorCode
    })
  }
})

const distDir = path.join(rootDir, 'dist')
app.use(express.static(distDir))
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).send('Run npm run build before using production static serving.')
  })
})

app.listen(port, () => {
  console.log(`kimi-codingplan-cosub listening on http://127.0.0.1:${port}`)
  if (!upstreamKey) {
    console.log('KIMI_API_KEY is not set. Proxy calls will return 503 until configured.')
  }
})

setInterval(() => {
  if (!store.data.settings.quotaCheckEnabled) return
  const intervalMs = Math.max(60, Number(store.data.settings.quotaCheckIntervalMinutes || 60)) * 60 * 1000
  if (Date.now() - lastOfficialAutoRefreshAt < intervalMs) return
  lastOfficialAutoRefreshAt = Date.now()
  refreshOfficialUsage().catch((error) => {
    console.warn(`official usage refresh failed: ${error.message}`)
  })
}, 60 * 1000)
