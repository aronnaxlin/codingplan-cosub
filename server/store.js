import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()

export class Store {
  constructor(file) {
    this.file = file
    this.data = {
      users: [],
      keys: [],
      usage: [],
      officialUsage: null,
      settings: {
        upstreamBaseUrl: process.env.KIMI_UPSTREAM_BASE_URL || 'https://api.kimi.com/coding/v1',
        globalConcurrencyLimit: Number(process.env.GLOBAL_CONCURRENCY_LIMIT || 2),
        keepUsageDays: 45,
        quotaCheckEnabled: false,
        quotaCheckIntervalMinutes: 60,
        quotaCheckUserAgent: process.env.KIMI_QUOTA_USER_AGENT || 'KimiThinProxy/0.1 quota-check',
        memberCount: 2,
        reservePercent: 10,
        totalFiveHourRequestLimit: 1307,
        totalWeeklyRequestLimit: 9073,
        totalMonthlyRequestLimit: 36292,
        totalFiveHourTokenLimit: 65000000,
        totalWeeklyTokenLimit: 357000000,
        totalMonthlyTokenLimit: 1428000000
      }
    }
    this.writeQueue = Promise.resolve()
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = {
        ...this.data,
        ...parsed,
        settings: { ...this.data.settings, ...(parsed.settings || {}) }
      }
      this.migrate()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.migrate()
      await this.save()
    }
  }

  migrate() {
    if (!Array.isArray(this.data.users)) this.data.users = []
    this.data.settings.memberCount = Math.max(1, Number(this.data.settings.memberCount || 2))
    this.data.settings.reservePercent = Math.max(0, Math.min(100, Number(this.data.settings.reservePercent ?? 10)))
    this.data.keys = this.data.keys.map((key) => ({
      quotaPercent: this.defaultQuotaPercent(),
      ...key
    }))
  }

  defaultQuotaPercent() {
    const memberCount = Math.max(1, Number(this.data.settings.memberCount || 2))
    const reservePercent = Math.max(0, Math.min(100, Number(this.data.settings.reservePercent ?? 10)))
    return Math.round(((100 - reservePercent) / memberCount) * 100) / 100
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2))
      await fs.rename(tmp, this.file)
    })
    return this.writeQueue
  }

  hashKey(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex')
  }

  generateSecret() {
    return `kp_${crypto.randomBytes(24).toString('base64url')}`
  }

  getUser(id) {
    return this.data.users.find((u) => u.id === id) || null
  }

  getUserByUsername(username) {
    return this.data.users.find((u) => u.username === username) || null
  }

  listUsers() {
    return this.data.users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt
    }))
  }

  async createUser(input) {
    const record = {
      id: crypto.randomUUID(),
      username: String(input.username || '').trim(),
      passwordHash: String(input.passwordHash || ''),
      role: input.role === 'admin' ? 'admin' : 'user',
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    this.data.users.push(record)
    await this.save()
    return { id: record.id, username: record.username, role: record.role, createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  async updateUser(id, patch) {
    const user = this.getUser(id)
    if (!user) return null
    if (Object.prototype.hasOwnProperty.call(patch, 'username')) {
      user.username = String(patch.username || '').trim()
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
      user.role = patch.role === 'admin' ? 'admin' : 'user'
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'passwordHash')) {
      user.passwordHash = String(patch.passwordHash || '')
    }
    user.updatedAt = nowIso()
    await this.save()
    return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt }
  }

  async deleteUser(id) {
    const before = this.data.users.length
    this.data.users = this.data.users.filter((u) => u.id !== id)
    for (const key of this.data.keys) {
      if (key.assignedToUserId === id) {
        key.assignedToUserId = null
        key.updatedAt = nowIso()
      }
    }
    await this.save()
    return this.data.users.length !== before
  }

  publicKey(record) {
    const {
      keyHash,
      fiveHourRequestLimit,
      weeklyRequestLimit,
      fiveHourTokenLimit,
      weeklyTokenLimit,
      ...rest
    } = record
    return rest
  }

  listKeys() {
    return this.data.keys.map((key) => this.publicKey(key))
  }

  listKeysForUser(userId) {
    return this.data.keys
      .filter((key) => key.assignedToUserId === userId)
      .map((key) => this.publicKey(key))
  }

  findKeyBySecret(secret) {
    if (!secret) return null
    const hash = this.hashKey(secret)
    return this.data.keys.find((key) => key.keyHash === hash) || null
  }

  getKey(id) {
    return this.data.keys.find((key) => key.id === id) || null
  }

  async createKey(input) {
    const secret = this.generateSecret()
    const record = {
      id: crypto.randomUUID(),
      name: String(input.name || 'Team member'),
      keyHash: this.hashKey(secret),
      keyPreview: `${secret.slice(0, 7)}...${secret.slice(-4)}`,
      secret,
      active: input.active !== false,
      quotaPercent: Object.prototype.hasOwnProperty.call(input, 'quotaPercent')
        ? Math.max(0, Math.min(100, Number(input.quotaPercent || 0)))
        : this.defaultQuotaPercent(),
      concurrencyLimit: Number(input.concurrencyLimit || 1),
      notes: String(input.notes || ''),
      assignedToUserId: input.assignedToUserId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastUsedAt: null
    }
    this.data.keys.push(record)
    await this.save()
    return { key: this.publicKey(record), secret }
  }

  async updateKey(id, patch) {
    const key = this.getKey(id)
    if (!key) return null
    const fields = [
      'name',
      'active',
      'quotaPercent',
      'concurrencyLimit',
      'notes',
      'assignedToUserId'
    ]
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        if (field === 'name' || field === 'notes') key[field] = String(patch[field] ?? '')
        else if (field === 'active') key[field] = Boolean(patch[field])
        else if (field === 'quotaPercent') key[field] = Math.max(0, Math.min(100, Number(patch[field] || 0)))
        else if (field === 'assignedToUserId') key[field] = patch[field] || null
        else key[field] = Math.max(0, Number(patch[field] || 0))
      }
    }
    key.updatedAt = nowIso()
    await this.save()
    return this.publicKey(key)
  }

  async rotateKey(id) {
    const key = this.getKey(id)
    if (!key) return null
    const secret = this.generateSecret()
    key.keyHash = this.hashKey(secret)
    key.keyPreview = `${secret.slice(0, 7)}...${secret.slice(-4)}`
    key.secret = secret
    key.updatedAt = nowIso()
    await this.save()
    return { key: this.publicKey(key), secret }
  }

  async deleteKey(id) {
    const before = this.data.keys.length
    this.data.keys = this.data.keys.filter((key) => key.id !== id)
    await this.save()
    return this.data.keys.length !== before
  }

  usageForKey(keyId, sinceMs) {
    const cutoff = Date.now() - sinceMs
    return this.data.usage.filter((item) => item.keyId === keyId && new Date(item.createdAt).getTime() >= cutoff)
  }

  usageStats(keyId) {
    const fiveHours = this.usageForKey(keyId, 5 * 60 * 60 * 1000)
    const week = this.usageForKey(keyId, 7 * 24 * 60 * 60 * 1000)
    const month = this.usageForKey(keyId, 30 * 24 * 60 * 60 * 1000)
    const summarize = (items) => ({
      requests: items.length,
      tokens: items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0),
      errors: items.filter((item) => item.status >= 400).length
    })
    return { fiveHours: summarize(fiveHours), week: summarize(week), month: summarize(month) }
  }

  quotaLimitsForKey(key) {
    const pct = Math.max(0, Number(key.quotaPercent || 0)) / 100
    const applyPct = (value) => {
      const num = Number(value || 0)
      if (num <= 0) return 0
      if (pct <= 0) return 0
      return Math.max(1, Math.floor(num * pct))
    }
    return {
      fiveHours: {
        requests: applyPct(this.data.settings.totalFiveHourRequestLimit),
        tokens: applyPct(this.data.settings.totalFiveHourTokenLimit)
      },
      week: {
        requests: applyPct(this.data.settings.totalWeeklyRequestLimit),
        tokens: applyPct(this.data.settings.totalWeeklyTokenLimit)
      },
      month: {
        requests: applyPct(this.data.settings.totalMonthlyRequestLimit),
        tokens: applyPct(this.data.settings.totalMonthlyTokenLimit)
      }
    }
  }

  usageReport(key) {
    const usage = this.usageStats(key.id)
    const limits = this.quotaLimitsForKey(key)
    const pct = (used, limit) => (limit > 0 ? Math.min(100, Math.round((Number(used || 0) / limit) * 100)) : 0)
    return {
      usage,
      limits,
      percentages: {
        fiveHours: {
          requests: pct(usage.fiveHours.requests, limits.fiveHours.requests),
          tokens: pct(usage.fiveHours.tokens, limits.fiveHours.tokens)
        },
        week: {
          requests: pct(usage.week.requests, limits.week.requests),
          tokens: pct(usage.week.tokens, limits.week.tokens)
        },
        month: {
          requests: pct(usage.month.requests, limits.month.requests),
          tokens: pct(usage.month.tokens, limits.month.tokens)
        }
      }
    }
  }

  async recordUsage(entry) {
    this.data.usage.unshift({
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      ...entry
    })
    const keepMs = Number(this.data.settings.keepUsageDays || 30) * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - keepMs
    this.data.usage = this.data.usage.filter((item) => new Date(item.createdAt).getTime() >= cutoff)
    const key = this.getKey(entry.keyId)
    if (key) key.lastUsedAt = nowIso()
    await this.save()
  }

  recentUsage(limit = 100) {
    return this.data.usage.slice(0, Math.max(1, Math.min(Number(limit || 100), 500)))
  }

  async recordOfficialUsage(result) {
    this.data.officialUsage = result
    await this.save()
    return this.data.officialUsage
  }

  async updateSettings(patch) {
    if (patch.upstreamBaseUrl) {
      this.data.settings.upstreamBaseUrl = String(patch.upstreamBaseUrl).replace(/\/+$/, '')
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'globalConcurrencyLimit')) {
      this.data.settings.globalConcurrencyLimit = Math.max(1, Number(patch.globalConcurrencyLimit || 1))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'keepUsageDays')) {
      this.data.settings.keepUsageDays = Math.max(30, Number(patch.keepUsageDays || 45))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quotaCheckEnabled')) {
      this.data.settings.quotaCheckEnabled = Boolean(patch.quotaCheckEnabled)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quotaCheckIntervalMinutes')) {
      this.data.settings.quotaCheckIntervalMinutes = Math.max(60, Number(patch.quotaCheckIntervalMinutes || 60))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quotaCheckUserAgent')) {
      this.data.settings.quotaCheckUserAgent = String(patch.quotaCheckUserAgent || 'KimiThinProxy/0.1 quota-check')
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'memberCount')) {
      this.data.settings.memberCount = Math.max(1, Number(patch.memberCount || 1))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reservePercent')) {
      this.data.settings.reservePercent = Math.max(0, Math.min(100, Number(patch.reservePercent ?? 10)))
    }
    const numericSettings = [
      'totalFiveHourRequestLimit',
      'totalWeeklyRequestLimit',
      'totalMonthlyRequestLimit',
      'totalFiveHourTokenLimit',
      'totalWeeklyTokenLimit',
      'totalMonthlyTokenLimit'
    ]
    for (const field of numericSettings) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        this.data.settings[field] = Math.max(0, Number(patch[field] || 0))
      }
    }
    await this.save()
    return this.data.settings
  }

  async applyQuotaAllocation() {
    const quotaPercent = this.defaultQuotaPercent()
    this.data.keys = this.data.keys.map((key) => ({
      ...key,
      quotaPercent,
      updatedAt: nowIso()
    }))
    await this.save()
    return {
      quotaPercent,
      keys: this.listKeys()
    }
  }
}
