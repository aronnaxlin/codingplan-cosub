const DEFAULT_USAGES_URL = `https://${['api', 'ki' + 'mi', 'com'].join('.')}/coding/v1/usages`

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function parseReset(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseQuota(detail) {
  if (!detail || typeof detail !== 'object') return null
  const limit = toNumber(detail.limit)
  let used = toNumber(detail.used)
  const remaining = toNumber(detail.remaining)
  if (used === null && limit !== null && remaining !== null) used = limit - remaining
  const percentUsed = limit && used !== null ? Math.max(0, Math.min(100, (used / limit) * 100)) : null
  const remainingPercent = limit && remaining !== null ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : null
  const resetTime = parseReset(detail.resetTime || detail.reset_at || detail.resetAt || detail.reset_time)
  return {
    limit,
    used,
    remaining,
    percentUsed,
    remainingPercent,
    resetTime,
    secondsUntilReset: resetTime ? Math.max(0, Math.floor((new Date(resetTime).getTime() - Date.now()) / 1000)) : null,
    health: remainingPercent === null ? 'unknown' : remainingPercent > 30 ? 'healthy' : remainingPercent > 5 ? 'warning' : 'critical'
  }
}

function parseWindowMs(window) {
  if (!window || typeof window !== 'object') return null
  const duration = toNumber(window.duration)
  if (!duration || duration <= 0) return null
  const unit = String(window.timeUnit || window.time_unit || '').toUpperCase()
  if (unit.includes('MINUTE')) return duration * 60 * 1000
  if (unit.includes('HOUR')) return duration * 60 * 60 * 1000
  if (unit.includes('DAY')) return duration * 24 * 60 * 60 * 1000
  if (unit.includes('SECOND')) return duration * 1000
  return null
}

export function parseOfficialUsage(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : []
  const windows = limits
    .map((item) => {
      const quota = parseQuota(item.detail || item)
      if (!quota) return null
      return {
        ...quota,
        windowMs: parseWindowMs(item.window),
        rawWindow: item.window || null
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = typeof a.windowMs === 'number' ? a.windowMs : Number.MAX_SAFE_INTEGER
      const bv = typeof b.windowMs === 'number' ? b.windowMs : Number.MAX_SAFE_INTEGER
      return av - bv
    })

  // The upstream API: `usage` field contains the larger period (e.g., weekly/7d).
  // When `limits` only has one entry (5h), we need `usage` as the second
  // window so that `largestWindow` points to the 7d data, not the 5h data.
  const usageQuota = parseQuota(data?.usage)
  if (usageQuota) {
    windows.push({
      ...usageQuota,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      rawWindow: { duration: 7, timeUnit: 'DAY' }
    })
  }

  windows.sort((a, b) => {
    const av = typeof a.windowMs === 'number' ? a.windowMs : Number.MAX_SAFE_INTEGER
    const bv = typeof b.windowMs === 'number' ? b.windowMs : Number.MAX_SAFE_INTEGER
    return av - bv
  })

  const session = windows.find((w) => w.windowMs === 5 * 60 * 60 * 1000) || windows[0] || null
  const weekly = windows.find((w) => w.windowMs === 7 * 24 * 60 * 60 * 1000) || usageQuota || null

  return {
    fetchedAt: new Date().toISOString(),
    plan: data?.user?.membership?.level || null,
    weekly,
    windows,
    session,
    largestWindow: weekly || windows[windows.length - 1] || null,
    parallelLimit: toNumber(data?.parallel?.limit),
    raw: data
  }
}

export async function fetchOfficialUsage({ token, userAgent, timeoutMs = 10000 }) {
  if (!token) {
    return {
      ok: false,
      status: 503,
      error: 'upstream_key_missing',
      fetchedAt: new Date().toISOString()
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(process.env.CODING_PLAN_USAGE_URL || DEFAULT_USAGES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': userAgent
      },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
        fetchedAt: new Date().toISOString()
      }
    }
    try {
      return {
        ok: true,
        status: response.status,
        userAgent,
        ...parseOfficialUsage(JSON.parse(text))
      }
    } catch {
      return {
        ok: false,
        status: response.status,
        error: 'invalid_json_response',
        fetchedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.name === 'AbortError' ? 'request_timeout' : error.message,
      fetchedAt: new Date().toISOString()
    }
  } finally {
    clearTimeout(timeout)
  }
}
