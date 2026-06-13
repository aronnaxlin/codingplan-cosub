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

  // Some strict validators reject any siblings alongside $ref.
  // Keep ONLY $ref to avoid "conflicting keywords found after $ref expansion" errors.
  if (hasRef) {
    result['$ref'] = obj['$ref']
    return result
  }

  for (const [key, value] of Object.entries(obj)) {
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
    } else if ((key === 'definitions' || key === '$defs') && value && typeof value === 'object') {
      const cleaned = {}
      for (const [dk, dv] of Object.entries(value)) {
        cleaned[dk] = sanitizeSchema(dv)
      }
      result[key] = cleaned
    } else if (key === 'patternProperties' && value && typeof value === 'object') {
      const cleaned = {}
      for (const [pk, pv] of Object.entries(value)) {
        cleaned[pk] = sanitizeSchema(pv)
      }
      result[key] = cleaned
    } else {
      result[key] = value
    }
  }
  return result
}

function sanitizeContentValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeContentBlock)
  return value
}

function sanitizeContentBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block

  if (block.type === 'tool_reference') {
    const toolName = typeof block.tool_name === 'string' ? block.tool_name : 'deferred tool'
    return {
      type: 'text',
      text: `Tool reference available: ${toolName}`
    }
  }

  const next = { ...block }
  if (Object.prototype.hasOwnProperty.call(next, 'content')) {
    next.content = sanitizeContentValue(next.content)
  }
  return next
}

export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message
    if (!Object.prototype.hasOwnProperty.call(message, 'content')) return message
    return {
      ...message,
      content: sanitizeContentValue(message.content)
    }
  })
}

export function upstreamUrl(baseUrl, req) {
  // Some clients (Anthropic SDK with base URL ending in /v1) send /v1/v1/messages.
  // Normalize both /v1/messages and /v1/v1/messages to the same upstream path.
  const stripped = req.path.replace(/^(\/v1)+\/?/, '')
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
