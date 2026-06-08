import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { ConcurrencyGate, checkRollingLimits } from './limits.js'
import { buildForwardHeaders, estimateTokens, extractBearer, pickModel, pipeUpstreamResponse, upstreamUrl } from './proxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const port = Number(process.env.PORT || 8787)
const adminToken = process.env.ADMIN_TOKEN || 'change-this-admin-token'
const upstreamKey = process.env.KIMI_API_KEY || ''
const store = new Store(path.resolve(rootDir, process.env.DATA_FILE || './data/store.json'))
const gate = new ConcurrencyGate()

await store.load()

const app = express()
app.disable('x-powered-by')

app.use('/api', express.json({ limit: '2mb' }))

function requireAdmin(req, res, next) {
  const token = extractBearer(req) || req.get('x-admin-token')
  if (!token || token !== adminToken) {
    res.status(401).json({ error: 'admin_unauthorized' })
    return
  }
  next()
}

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
    settings: store.data.settings
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, hasUpstreamKey: Boolean(upstreamKey), settings: store.data.settings })
})

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  res.json(dashboardStats())
})

app.get('/api/admin/keys', requireAdmin, (_req, res) => {
  const keys = store.data.keys.map((key) => ({ ...store.publicKey(key), ...store.usageReport(key) }))
  res.json(keys)
})

app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const created = await store.createKey(req.body || {})
  res.status(201).json(created)
})

app.patch('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const key = await store.updateKey(req.params.id, req.body || {})
  if (!key) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.json(key)
})

app.post('/api/admin/keys/:id/rotate', requireAdmin, async (req, res) => {
  const rotated = await store.rotateKey(req.params.id)
  if (!rotated) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.json(rotated)
})

app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const deleted = await store.deleteKey(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'key_not_found' })
    return
  }
  res.status(204).end()
})

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  res.json(store.recentUsage(req.query.limit || 100))
})

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({ ...store.data.settings, hasUpstreamKey: Boolean(upstreamKey) })
})

app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await store.updateSettings(req.body || {})
  res.json({ ...settings, hasUpstreamKey: Boolean(upstreamKey) })
})

app.use('/v1', express.raw({ type: '*/*', limit: '50mb' }))

app.all('/v1/*splat', async (req, res) => {
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
app.get('*splat', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).send('Run npm run build before using production static serving.')
  })
})

app.listen(port, () => {
  console.log(`Kimi thin proxy listening on http://127.0.0.1:${port}`)
  if (adminToken === 'change-this-admin-token') {
    console.log('ADMIN_TOKEN is using the example value. Set a private token before deployment.')
  }
  if (!upstreamKey) {
    console.log('KIMI_API_KEY is not set. Proxy calls will return 503 until configured.')
  }
})
