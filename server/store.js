import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const RESET_GRACE_MS = 60 * 1000
const WINDOW_DEFS = {
  fiveHours: { ms: FIVE_HOURS_MS, tokenLimitField: 'totalFiveHourTokenLimit', requestLimitField: 'totalFiveHourRequestLimit' },
  week: { ms: WEEK_MS, tokenLimitField: 'totalWeeklyTokenLimit', requestLimitField: 'totalWeeklyRequestLimit' }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

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
        quotaCheckIntervalMinutes: 0,
        quotaCheckOn429: true,
        quotaCheckUserAgent: process.env.KIMI_QUOTA_USER_AGENT || 'KimiThinProxy/0.1 quota-check',
        memberCount: 2,
        reservePercent: 10,
        externalUsageWeight: 1,
        totalFiveHourRequestLimit: 1307,
        totalWeeklyRequestLimit: 9073,
        totalFiveHourTokenLimit: 65000000,
        totalWeeklyTokenLimit: 357000000
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
    this.data.settings.externalUsageWeight = clamp(Number(this.data.settings.externalUsageWeight ?? 1), 0, 1)
    delete this.data.settings.strictMode
    delete this.data.settings.borrowEnabled
    delete this.data.settings.borrowCapPercent
    delete this.data.settings.totalMonthlyRequestLimit
    delete this.data.settings.totalMonthlyTokenLimit
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

  officialWindowForName(official, windowName) {
    if (!official?.ok) return null
    const expectedMs = WINDOW_DEFS[windowName]?.ms
    if (!expectedMs) return null
    const windows = Array.isArray(official.windows) ? official.windows : []
    return windows.find((w) => w.windowMs === expectedMs) ||
      (windowName === 'fiveHours' ? official.session : official.weekly || official.largestWindow) ||
      null
  }

  cutoffForWindow(windowName, official = this.data.officialUsage) {
    const windowDef = WINDOW_DEFS[windowName]
    if (!windowDef) return Date.now()

    const officialWindow = this.officialWindowForName(official, windowName)
    if (this.data.settings.quotaCheckEnabled && officialWindow?.resetTime) {
      const resetAt = new Date(officialWindow.resetTime).getTime()
      if (Number.isFinite(resetAt)) {
        if (Date.now() >= resetAt + RESET_GRACE_MS) return resetAt
        return resetAt - windowDef.ms
      }
    }

    return Date.now() - windowDef.ms
  }

  usageForKeySince(keyId, cutoff) {
    return this.data.usage.filter((item) => item.keyId === keyId && new Date(item.createdAt).getTime() >= cutoff)
  }

  usageStats(keyId, official = this.data.officialUsage) {
    const fiveHours = this.usageForKeySince(keyId, this.cutoffForWindow('fiveHours', official))
    const week = this.usageForKeySince(keyId, this.cutoffForWindow('week', official))
    const summarize = (items) => ({
      requests: items.length,
      tokens: items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0),
      errors: items.filter((item) => item.status >= 400).length
    })
    return { fiveHours: summarize(fiveHours), week: summarize(week) }
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
        }
      }
    }
  }

  /**
   * Compute dynamic limits.
   *
   * Algorithm ("reverse-inferred total + reserve absorption"):
   *   Kimi API returns used/remaining as percentages.
   *   At official refresh time we compute:
   *     inferredTotal = totalLocalUsed / officialUsedFraction
   *   If it is near the configured preset, it becomes the cycle total.
   *   If official usage is much higher than local proxy usage, the difference is
   *   treated as external drain. That drain spends the reserve first, then scales
   *   everyone down proportionally.
   *   Local usage changes after refresh only affect the numerator.
   *
   *   Request limits still use static presets (official has no request data).
   */
  dynamicLimitsForKey(keyId, official) {
    const key = this.getKey(keyId)
    if (!key) return null

    const baseQuota = this.quotaLimitsForKey(key)
    const report = this.usageReport(key)
    const stats = report.usage

    const makeWindow = (windowName, officialWindow, baseReqLimit, baseTokenLimit) => {
      // --- Request limit: no official data, use static preset ---
      const reqUsed = Number(stats[windowName].requests || 0)

      // --- Token limit: use the FIXED inferredTotal stored at refresh time ---
      let tokenDynamicLimit = baseTokenLimit
      let inferredTotal = null
      let effectiveTotal = baseTokenLimit
      let externalUsageTokens = 0
      let reserveAbsorbedTokens = 0
      let userPoolScale = 1
      let confidence = 0

      if (officialWindow?.quotaInference) {
        inferredTotal = officialWindow.quotaInference.inferredTotal
        effectiveTotal = officialWindow.quotaInference.effectiveTotal || baseTokenLimit
        externalUsageTokens = officialWindow.quotaInference.externalUsageTokens || 0
        reserveAbsorbedTokens = officialWindow.quotaInference.reserveAbsorbedTokens || 0
        userPoolScale = officialWindow.quotaInference.userPoolScale ?? 1
        confidence = officialWindow.quotaInference.confidence || 0
        const myPct = Math.max(0, Number(key.quotaPercent || 0)) / 100
        tokenDynamicLimit = Math.max(1, Math.floor(effectiveTotal * myPct * userPoolScale))
      } else if (officialWindow?.inferredTotal != null && officialWindow.inferredTotal > 0) {
        inferredTotal = officialWindow.inferredTotal
        const myPct = Math.max(0, Number(key.quotaPercent || 0)) / 100
        tokenDynamicLimit = Math.max(1, Math.floor(inferredTotal * myPct))
      }

      const tokenUsed = Number(stats[windowName].tokens || 0)

      return {
        dynamicLimit: baseReqLimit,
        remaining: Math.max(0, baseReqLimit - reqUsed),
        tokenDynamicLimit,
        tokenRemaining: Math.max(0, tokenDynamicLimit - tokenUsed),
        officialRemaining: officialWindow?.remaining ?? null,
        inferredTotal,
        effectiveTotal,
        externalUsageTokens,
        reserveAbsorbedTokens,
        userPoolScale,
        confidence
      }
    }

    return {
      fiveHours: makeWindow('fiveHours', this.officialWindowForName(official, 'fiveHours'), baseQuota.fiveHours.requests, baseQuota.fiveHours.tokens),
      week: makeWindow('week', this.officialWindowForName(official, 'week'), baseQuota.week.requests, baseQuota.week.tokens)
    }
  }

  officialUsedFraction(window) {
    if (!window) return null
    if (window.percentUsed != null) return clamp(Number(window.percentUsed) / 100, 0, 1)
    if (window.limit && window.used != null) return clamp(Number(window.used) / Number(window.limit), 0, 1)
    if (window.remainingPercent != null) return clamp(1 - Number(window.remainingPercent) / 100, 0, 1)
    return null
  }

  totalLocalTokensForWindow(windowName, official) {
    const cutoff = this.cutoffForWindow(windowName, official)
    return this.data.keys.reduce((sum, key) => {
      const tokens = this.usageForKeySince(key.id, cutoff)
        .reduce((inner, item) => inner + Number(item.totalTokens || 0), 0)
      return sum + tokens
    }, 0)
  }

  buildQuotaInference(windowName, officialWindow, official) {
    const windowDef = WINDOW_DEFS[windowName]
    if (!windowDef || !officialWindow) return null

    const baseLimit = Number(this.data.settings[windowDef.tokenLimitField] || 0)
    const usedFraction = this.officialUsedFraction(officialWindow)
    if (!usedFraction || usedFraction <= 0) return null

    const localUsedTokens = this.totalLocalTokensForWindow(windowName, official)
    const reserveFraction = clamp(Number(this.data.settings.reservePercent ?? 10) / 100, 0, 1)
    const externalUsageWeight = clamp(Number(this.data.settings.externalUsageWeight ?? 1), 0, 1)
    const inferredTotal = localUsedTokens > 0 ? localUsedTokens / usedFraction : null

    if (baseLimit <= 0 && inferredTotal) {
      return {
        inferredTotal: Math.round(inferredTotal),
        effectiveTotal: Math.max(1, Math.round(inferredTotal)),
        localUsedTokens,
        officialUsedPercent: usedFraction * 100,
        externalUsageTokens: 0,
        reserveAbsorbedTokens: 0,
        userPoolScale: 1,
        confidence: 1,
        mode: 'official_inferred'
      }
    }

    const minPlausible = baseLimit * 0.5
    const maxPlausible = baseLimit * 1.5
    const inferredIsPlausible = inferredTotal !== null && inferredTotal >= minPlausible && inferredTotal <= maxPlausible

    if (inferredIsPlausible) {
      return {
        inferredTotal: Math.round(inferredTotal),
        effectiveTotal: Math.max(1, Math.round(inferredTotal)),
        localUsedTokens,
        officialUsedPercent: usedFraction * 100,
        externalUsageTokens: 0,
        reserveAbsorbedTokens: 0,
        userPoolScale: 1,
        confidence: 1,
        mode: 'official_inferred'
      }
    }

    const officialConsumedByPreset = baseLimit * usedFraction
    const externalUsageTokens = Math.max(0, officialConsumedByPreset - localUsedTokens) * externalUsageWeight
    const reserveTokens = baseLimit * reserveFraction
    const reserveAbsorbedTokens = Math.min(externalUsageTokens, reserveTokens)
    const externalOverflowTokens = Math.max(0, externalUsageTokens - reserveAbsorbedTokens)
    const allocatablePool = Math.max(1, baseLimit * (1 - reserveFraction))
    const userPoolScale = clamp((allocatablePool - externalOverflowTokens) / allocatablePool, 0, 1)

    return {
      inferredTotal: inferredTotal === null ? null : Math.round(inferredTotal),
      effectiveTotal: baseLimit,
      localUsedTokens,
      officialUsedPercent: usedFraction * 100,
      externalUsageTokens: Math.round(externalUsageTokens),
      reserveAbsorbedTokens: Math.round(reserveAbsorbedTokens),
      userPoolScale,
      confidence: 0,
      mode: externalUsageTokens > 0 ? 'preset_with_external_drain' : 'preset'
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
    // Compute inferred totals at refresh time so they stay fixed for the cycle.
    // Local usage changes after this point only affect the numerator, not the denominator.
    if (result.ok) {
      for (const windowName of Object.keys(WINDOW_DEFS)) {
        const officialWindow = this.officialWindowForName(result, windowName)
        const inference = this.buildQuotaInference(windowName, officialWindow, result)
        if (officialWindow && inference) {
          officialWindow.quotaInference = inference
          officialWindow.inferredTotal = inference.effectiveTotal
        }
      }
    }
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
      this.data.settings.quotaCheckIntervalMinutes = Math.max(0, Number(patch.quotaCheckIntervalMinutes || 0))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quotaCheckOn429')) {
      this.data.settings.quotaCheckOn429 = Boolean(patch.quotaCheckOn429)
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
    if (Object.prototype.hasOwnProperty.call(patch, 'externalUsageWeight')) {
      this.data.settings.externalUsageWeight = clamp(Number(patch.externalUsageWeight ?? 1), 0, 1)
    }
    const numericSettings = [
      'totalFiveHourRequestLimit',
      'totalWeeklyRequestLimit',
      'totalFiveHourTokenLimit',
      'totalWeeklyTokenLimit'
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
