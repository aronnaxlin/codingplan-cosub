import { Readable } from 'node:stream'

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
  const stream = Readable.fromWeb(upstreamResponse.body)
  stream.on('data', (chunk) => {
    onChunk(chunk)
  })
  stream.pipe(res)
  await new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
    res.on('close', resolve)
  })
}
