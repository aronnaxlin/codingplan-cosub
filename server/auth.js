import crypto from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET || process.env.ADMIN_TOKEN || 'change-me-secret')

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split('.')
  if (!saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64url')
  return hashB64 === expected
}

export async function createToken(user) {
  return new SignJWT({ sub: user.id, role: user.role, username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret, { clockTolerance: 60 })
    return payload
  } catch {
    return null
  }
}

export async function requireAuth(req, res, next) {
  const auth = req.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const payload = await verifyToken(token)
  if (!payload) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  req.user = payload
  next()
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  next()
}
