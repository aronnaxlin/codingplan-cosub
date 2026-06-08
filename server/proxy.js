const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
])

export function extractBearer(req) {
  const auth = req.get('authorization') || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

export function estimateTokens(value) {
  if (!value) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil(text.length / 4)
}

export function pickModel(body) {
  return body && typeof body === 'object' && body.model ? String(body.model) : ''
}

export function sanitizeSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sanitizeSchema)
  const result = {}
  const hasRef = Object.prototype.hasOwnProperty.call(obj, '$ref')
  for (const [key, value] of Object.entries(obj)) {
    if (hasRef && key === 'description') continue
    if (key === 'properties' && value && typeof value === 'object') {
      const cleaned = {}
      for (const [pk, pv] of Object.entries(value)) {
        cleaned[pk] = sanitizeSchema(pv)
      }
      result[key] = cleaned
    } else if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object') {
      result[key] = sanitizeSchema(value)
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      result[key] = Array.isArray(value) ? value.map(sanitizeSchema) : sanitizeSchema(value)
    } else {
      result[key] = value
    }
  }
  return result
}

export function upstreamUrl(baseUrl, req) {
  const stripped = req.path.replace(/^\/v1\/?/, '')
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  return `${baseUrl.replace(/\/+$/, '')}/${stripped}${query}`
}

export function buildForwardHeaders(req, upstreamKey) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'authorization') continue
    if (Array.isArray(value)) headers[name] = value.join(', ')
    else if (value != null) headers[name] = String(value)
  }
  headers.authorization = `Bearer ${upstreamKey}`
  if (req.headers['user-agent']) {
    headers['user-agent'] = String(req.headers['user-agent'])
  }
  return headers
}

export async function pipeUpstreamResponse(upstreamResponse, res, onChunk) {
  res.status(upstreamResponse.status)
  upstreamResponse.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (!HOP_BY_HOP.has(lower)) res.setHeader(name, value)
  })
  if (!upstreamResponse.body) {
    res.end()
    return
  }
  const reader = upstreamResponse.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk(value)
      res.write(value)
    }
    res.end()
  } catch (error) {
    res.end()
    throw error
  }
}
