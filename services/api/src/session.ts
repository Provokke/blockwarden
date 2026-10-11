import { jwtVerify, SignJWT } from 'jose'
import { getAddress, isAddress, type Address } from 'viem'
import { serializeCookie } from './http.js'

export const SESSION_COOKIE = 'bw_session'
export const SESSION_SECONDS = 12 * 60 * 60

const ALGORITHM = 'HS256'
const ISSUER = 'blockwarden'
const AUDIENCE = 'blockwarden-dashboard'

export type Session = { address: Address; issuedAt: number; expiresAt: number }

export async function mintSession(secret: Uint8Array, address: Address, nowMs: number): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1000)
  return new SignJWT({ address: getAddress(address) })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_SECONDS)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(secret)
}

export async function verifySession(secret: Uint8Array, token: string, nowMs: number): Promise<Session | undefined> {
  let payload
  try {
    // algorithms is a list we supply, never one read from the token's own header
    ;({ payload } = await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
    }))
  } catch {
    return undefined
  }
  const address: unknown = payload.address
  if (typeof address !== 'string' || !isAddress(address)) return undefined
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return undefined
  // reject tokens minted in the future to prevent clock skew attacks
  if (payload.iat * 1000 > nowMs) return undefined
  return { address: getAddress(address), issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 }
}

export function sessionCookie(token: string): string {
  return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_SECONDS, path: '/' })
}

export function clearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, path: '/' })
}
