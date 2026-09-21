import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  clearedSessionCookie,
  mintSession,
  sessionCookie,
  verifySession,
} from '../../src/session.js'

const secret = new TextEncoder().encode('a'.repeat(48))
const other = new TextEncoder().encode('b'.repeat(48))
const address = '0x2222222222222222222222222222222222222222' as const
const now = 1_770_000_000_000

describe('mintSession and verifySession', () => {
  it('round-trips the address and the window', async () => {
    const token = await mintSession(secret, address, now)
    const session = await verifySession(secret, token, now)
    expect(session).toEqual({ address, issuedAt: now, expiresAt: now + SESSION_SECONDS * 1000 })
  })

  it('lasts twelve hours', () => {
    expect(SESSION_SECONDS).toBe(12 * 60 * 60)
  })

  it('refuses a token signed with another secret', async () => {
    const token = await mintSession(other, address, now)
    expect(await verifySession(secret, token, now)).toBeUndefined()
  })

  it('refuses a token one second past its expiry', async () => {
    const token = await mintSession(secret, address, now)
    expect(await verifySession(secret, token, now + SESSION_SECONDS * 1000 + 1000)).toBeUndefined()
  })

  it('accepts a token one second before its expiry', async () => {
    const token = await mintSession(secret, address, now)
    expect(await verifySession(secret, token, now + SESSION_SECONDS * 1000 - 1000)).toBeDefined()
  })

  it('refuses a token minted for the future, so a clock skew cannot mint a longer session', async () => {
    const token = await mintSession(secret, address, now + 10 * 60_000)
    expect(await verifySession(secret, token, now)).toBeUndefined()
  })

  it('refuses rubbish without throwing', async () => {
    for (const bad of ['', 'x', 'a.b.c', 'a.b', '...']) {
      expect(await verifySession(secret, bad, now)).toBeUndefined()
    }
  })

  it('refuses a token whose algorithm is not the one we sign with', async () => {
    // alg confusion: the classic JWT failure is trusting the header's own claim about how to check it
    const unsigned = await new SignJWT({ address })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
      .setIssuer('blockwarden')
      .setAudience('blockwarden-dashboard')
      .sign(secret)
    expect(await verifySession(secret, unsigned, now)).toBeUndefined()
  })

  it('refuses a token issued for another audience', async () => {
    const wrong = await new SignJWT({ address })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
      .setIssuer('blockwarden')
      .setAudience('somewhere-else')
      .sign(secret)
    expect(await verifySession(secret, wrong, now)).toBeUndefined()
  })

  it('refuses a token with no address, rather than returning one that is undefined', async () => {
    const empty = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
      .setIssuer('blockwarden')
      .setAudience('blockwarden-dashboard')
      .sign(secret)
    expect(await verifySession(secret, empty, now)).toBeUndefined()
  })

  it('refuses an address that is not an address', async () => {
    const bad = await new SignJWT({ address: 'steve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
      .setIssuer('blockwarden')
      .setAudience('blockwarden-dashboard')
      .sign(secret)
    expect(await verifySession(secret, bad, now)).toBeUndefined()
  })

  it('returns the address in its checksummed form, whatever case was signed', async () => {
    const lower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const token = await mintSession(secret, lower as never, now)
    const session = await verifySession(secret, token, now)
    expect(session?.address).toBe('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
  })
})

describe('the cookie', () => {
  it('is named once and carries the session lifetime', () => {
    expect(SESSION_COOKIE).toBe('bw_session')
    expect(sessionCookie('token-value')).toBe(
      `bw_session=token-value; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    )
  })

  it('clears with an empty value and a zero lifetime', () => {
    expect(clearedSessionCookie()).toBe('bw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict')
  })
})
