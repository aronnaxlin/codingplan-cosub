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

export function checkRollingLimits(store, key) {
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
  const checks = [
    ['five_hour_request_limit', stats.fiveHours.requests, limits.fiveHours.requests],
    ['weekly_request_limit', stats.week.requests, limits.week.requests],
    ['monthly_request_limit', stats.month.requests, limits.month.requests],
    ['five_hour_token_limit', stats.fiveHours.tokens, limits.fiveHours.tokens],
    ['weekly_token_limit', stats.week.tokens, limits.week.tokens],
    ['monthly_token_limit', stats.month.tokens, limits.month.tokens]
  ]
  for (const [reason, used, limit] of checks) {
    if (limit > 0 && used >= limit) {
      return { ok: false, reason, used, limit, stats, limits }
    }
  }
  return { ok: true, stats, limits }
}
