export class ConcurrencyGate {
  constructor() {
    this.globalActive = 0
    this.byKey = new Map()
  }

  canEnter(keyId, keyLimit, globalLimit) {
    const keyActive = this.byKey.get(keyId) || 0
    if (this.globalActive >= globalLimit) return { ok: false, reason: 'global_concurrency_limit' }
    if (keyActive >= keyLimit) return { ok: false, reason: 'key_concurrency_limit' }
    return { ok: true }
  }

  enter(keyId) {
    this.globalActive += 1
    this.byKey.set(keyId, (this.byKey.get(keyId) || 0) + 1)
  }

  leave(keyId) {
    this.globalActive = Math.max(0, this.globalActive - 1)
    const next = Math.max(0, (this.byKey.get(keyId) || 0) - 1)
    if (next === 0) this.byKey.delete(keyId)
    else this.byKey.set(keyId, next)
  }

  snapshot() {
    return {
      globalActive: this.globalActive,
      byKey: Object.fromEntries(this.byKey.entries())
    }
  }
}

export function checkRollingLimits(store, key, projectedTokens = 0) {
  if (Number(key.quotaPercent || 0) <= 0) {
    return {
      ok: false,
      reason: 'quota_percent_zero',
      used: 0,
      limit: 0,
      stats: store.usageStats(key.id),
      limits: store.quotaLimitsForKey(key)
    }
  }
  const report = store.usageReport(key)
  const stats = report.usage
  const limits = report.limits
  const dynamicLimits = store.dynamicLimitsForKey(key.id, store.data.officialUsage)
  const fiveHourTokenLimit = dynamicLimits?.fiveHours?.tokenDynamicLimit || limits.fiveHours.tokens
  const weeklyTokenLimit = dynamicLimits?.week?.tokenDynamicLimit || limits.week.tokens
  const tokenProjection = Math.max(0, Number(projectedTokens || 0))
  const checks = [
    ['five_hour_request_limit', stats.fiveHours.requests, limits.fiveHours.requests],
    ['weekly_request_limit', stats.week.requests, limits.week.requests],
    ['five_hour_token_limit', stats.fiveHours.tokens + tokenProjection, fiveHourTokenLimit],
    ['weekly_token_limit', stats.week.tokens + tokenProjection, weeklyTokenLimit]
  ]
  for (const [reason, used, limit] of checks) {
    if (limit > 0 && used >= limit) {
      return { ok: false, reason, used, limit, stats, limits }
    }
  }
  return { ok: true, stats, limits, dynamicLimits }
}

/**
 * Check official upstream quota as a hard ceiling.
 */
export function checkOfficialLimits(store, key) {
  const official = store.data.officialUsage
  const settings = store.data.settings

  // Fail-open when official check is disabled or data unavailable
  if (!settings.quotaCheckEnabled || !official || !official.ok) {
    return { ok: true, source: 'disabled_or_unavailable' }
  }

  const now = Date.now()
  const fetchedAt = official.fetchedAt ? new Date(official.fetchedAt).getTime() : 0
  const ageMs = now - fetchedAt
  const maxStaleMs = 30 * 60 * 1000 // 30 minutes — beyond this, data is too stale to trust

  if (ageMs > maxStaleMs) {
    return { ok: true, source: 'stale_data', staleMs: ageMs }
  }

  const windows = [
    ['official_session_exhausted', official.session],
    ['official_weekly_exhausted', official.weekly || official.largestWindow]
  ]
  for (const [reason, window] of windows) {
    if (!window) continue
    const remainingPercent = window.remainingPercent
    const remaining = window.remaining
    if ((remainingPercent != null && remainingPercent <= 0) || (remaining != null && remaining <= 0)) {
      return {
        ok: false,
        source: 'official',
        reason,
        message: 'The official quota window is exhausted.',
        resetsAt: window.resetTime || null
      }
    }
  }

  return { ok: true, source: 'official_passed' }
}
