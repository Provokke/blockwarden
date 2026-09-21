import { describe, expect, it } from 'vitest'
import { authorize, callerFromContext, isDashboard, mayUseSigner, type AuthorizerDeps } from '../../src/authorizer.js'
import { mintSession } from '../../src/session.js'

const secret = new TextEncoder().encode('s'.repeat(48))
const address = '0x1111111111111111111111111111111111111111' as const
const now = 1_770_000_000_000
const keyRecord = { hash: 'a'.repeat(64), signerIds: ['demo'], label: 'ci' }

function deps(): AuthorizerDeps {
  return {
    secret,
    now: () => now,
    store: {
      async getApiKey(hash) {
        return hash === keyRecord.hash ? keyRecord : undefined
      },
    },
    hash: (key) => (key === 'good-key' ? keyRecord.hash : 'b'.repeat(64)),
  }
}

function request(over: Record<string, unknown> = {}) {
  return { version: '2.0', routeKey: 'GET /v1/rules', headers: {}, ...over } as never
}

describe('authorize', () => {
  it('admits a valid session cookie and names the address', async () => {
    const token = await mintSession(secret, address, now)
    const result = await authorize(deps(), request({ cookies: [`bw_session=${token}`] }))
    expect(result.isAuthorized).toBe(true)
    expect(result.context).toEqual({ caller: JSON.stringify({ kind: 'session', address }) })
  })

  it('refuses an expired session', async () => {
    const token = await mintSession(secret, address, now - 13 * 60 * 60 * 1000)
    const result = await authorize(deps(), request({ cookies: [`bw_session=${token}`] }))
    expect(result).toEqual({ isAuthorized: false })
  })

  it('refuses a session signed with another secret', async () => {
    const token = await mintSession(new TextEncoder().encode('x'.repeat(48)), address, now)
    const result = await authorize(deps(), request({ cookies: [`bw_session=${token}`] }))
    expect(result).toEqual({ isAuthorized: false })
  })

  it('admits a known API key and carries its signer allowlist', async () => {
    const result = await authorize(deps(), request({ headers: { authorization: 'Bearer good-key' } }))
    expect(result.isAuthorized).toBe(true)
    expect(JSON.parse((result.context as { caller: string }).caller)).toEqual({
      kind: 'apiKey',
      hash: keyRecord.hash,
      signerIds: ['demo'],
      label: 'ci',
    })
  })

  it('refuses an unknown API key', async () => {
    const result = await authorize(deps(), request({ headers: { authorization: 'Bearer nope' } }))
    expect(result).toEqual({ isAuthorized: false })
  })

  it('accepts the scheme in any case, as RFC 7235 requires', async () => {
    const result = await authorize(deps(), request({ headers: { authorization: 'bEaReR good-key' } }))
    expect(result.isAuthorized).toBe(true)
  })

  it('refuses a request with neither credential', async () => {
    expect(await authorize(deps(), request())).toEqual({ isAuthorized: false })
  })

  it('prefers the session when both are present, and does not fall back to the key if it is bad', async () => {
    const expired = await mintSession(secret, address, now - 13 * 60 * 60 * 1000)
    const result = await authorize(
      deps(),
      request({ cookies: [`bw_session=${expired}`], headers: { authorization: 'Bearer good-key' } }),
    )
    // a stale cookie sitting in a browser must not silently borrow a machine key's authority
    expect(result).toEqual({ isAuthorized: false })
  })

  it('never puts the token or the key itself in the context', async () => {
    const token = await mintSession(secret, address, now)
    const result = await authorize(deps(), request({ cookies: [`bw_session=${token}`] }))
    expect(JSON.stringify(result.context)).not.toContain(token)
    const keyResult = await authorize(deps(), request({ headers: { authorization: 'Bearer good-key' } }))
    expect(JSON.stringify(keyResult.context)).not.toContain('good-key')
  })
})

describe('what a caller may do', () => {
  it('lets a session reach the dashboard routes', () => {
    expect(isDashboard({ kind: 'session', address })).toBe(true)
    expect(isDashboard({ kind: 'apiKey', hash: 'a', signerIds: [], label: 'x' })).toBe(false)
  })

  it('lets a session use any signer, and a key only its own', () => {
    expect(mayUseSigner({ kind: 'session', address }, 'anything')).toBe(true)
    // only `kind` needs the literal type; a whole-object `as const` would make signerIds readonly,
    // which Caller's signerIds: string[] does not accept
    const key = { kind: 'apiKey' as const, hash: 'a', signerIds: ['demo'], label: 'x' }
    expect(mayUseSigner(key, 'demo')).toBe(true)
    expect(mayUseSigner(key, 'other')).toBe(false)
  })
})

describe('callerFromContext', () => {
  it('reads back what the authorizer wrote', () => {
    const caller = { kind: 'session', address } as const
    const event = {
      requestContext: { authorizer: { lambda: { caller: JSON.stringify(caller) } } },
    } as never
    expect(callerFromContext(event)).toEqual(caller)
  })

  it('returns undefined when the context is missing or malformed, rather than throwing', () => {
    expect(callerFromContext({ requestContext: {} } as never)).toBeUndefined()
    expect(
      callerFromContext({ requestContext: { authorizer: { lambda: { caller: 'not json' } } } } as never),
    ).toBeUndefined()
  })

  it('refuses a context whose kind is not one we issue', () => {
    const event = {
      requestContext: { authorizer: { lambda: { caller: JSON.stringify({ kind: 'root' }) } } },
    } as never
    expect(callerFromContext(event)).toBeUndefined()
  })

  it('returns undefined rather than throwing when requestContext itself is absent', () => {
    expect(callerFromContext({} as never)).toBeUndefined()
  })
})
