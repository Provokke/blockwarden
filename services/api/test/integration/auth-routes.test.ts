import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleLogout, handleNonce, handleVerify } from '../../src/auth-routes.js'
import { verifySession } from '../../src/session.js'
import type { SiweDeps } from '../../src/siwe.js'
import { createStore } from '../../src/store.js'

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const secret = new TextEncoder().encode('s'.repeat(48))
let dynamo: Dynamo
let deps: SiweDeps
let nowMs = 1_770_000_000_000

beforeAll(async () => {
  dynamo = await startDynamo()
  const table = await dynamo.newTable()
  // no chain here: a chain-specialized client isn't structurally a bare PublicClient, and this client only
  // needs to exist for an EIP-1271 path an EOA signature never takes — its transport is unroutable on purpose
  const client = createPublicClient({ transport: http('http://127.0.0.1:1') })
  deps = {
    store: createStore({ doc: dynamo.doc, table }),
    settings: {
      domain: 'demo.blockwarden.dev',
      origin: 'https://demo.blockwarden.dev',
      chainIds: [8453],
      allowedWallets: [account.address],
    },
    publicClient: (chainId) => (chainId === 8453 ? client : undefined),
    secret,
    now: () => nowMs,
  }
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

async function signIn(over: Record<string, unknown> = {}) {
  const nonceResult = await handleNonce(deps)
  const { nonce } = nonceResult.body as { nonce: string }
  const message = createSiweMessage({
    address: account.address,
    chainId: 8453,
    domain: 'demo.blockwarden.dev',
    nonce,
    uri: 'https://demo.blockwarden.dev',
    version: '1',
    issuedAt: new Date(nowMs),
    expirationTime: new Date(nowMs + 120_000),
    ...over,
  } as never)
  const signature = await account.signMessage({ message })
  return { message, signature, nonce }
}

function event(body: unknown) {
  return { version: '2.0', routeKey: 'POST /v1/auth/siwe/verify', headers: {}, body: JSON.stringify(body) } as never
}

describe('the SIWE round trip', () => {
  it('signs in with a real signature and sets a session cookie', async () => {
    const { message, signature } = await signIn()
    const result = await handleVerify(deps, event({ message, signature }))
    expect(result.status).toBe(200)
    expect(result.cookies?.[0]).toMatch(/^bw_session=.+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/)
    const token = result.cookies![0]!.slice('bw_session='.length, result.cookies![0]!.indexOf(';'))
    const session = await verifySession(secret, token, nowMs)
    expect(session?.address).toBe(account.address)
  })

  it('refuses the same message a second time, because the nonce is spent', async () => {
    const { message, signature } = await signIn()
    expect((await handleVerify(deps, event({ message, signature }))).status).toBe(200)
    const replay = await handleVerify(deps, event({ message, signature }))
    expect(replay.status).toBe(401)
    expect((replay.body as { error: { code: string } }).error.code).toBe('siwe_nonce')
  })

  it('spends the nonce even when the signature is wrong, so one nonce buys one attempt', async () => {
    const { message } = await signIn()
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
    const wrong = await other.signMessage({ message })
    const first = await handleVerify(deps, event({ message, signature: wrong }))
    expect((first.body as { error: { code: string } }).error.code).toBe('siwe_signature')
    const second = await handleVerify(deps, event({ message, signature: wrong }))
    expect((second.body as { error: { code: string } }).error.code).toBe('siwe_nonce')
  })

  it('refuses a message whose nonce was never issued', async () => {
    const message = createSiweMessage({
      address: account.address,
      chainId: 8453,
      domain: 'demo.blockwarden.dev',
      nonce: 'neverissued1',
      uri: 'https://demo.blockwarden.dev',
      version: '1',
      issuedAt: new Date(nowMs),
      expirationTime: new Date(nowMs + 120_000),
    } as never)
    const signature = await account.signMessage({ message })
    const result = await handleVerify(deps, event({ message, signature }))
    expect((result.body as { error: { code: string } }).error.code).toBe('siwe_nonce')
  })

  it('refuses a wallet that is not on the allowlist before spending the nonce', async () => {
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
    const nonceResult = await handleNonce(deps)
    const { nonce } = nonceResult.body as { nonce: string }
    const message = createSiweMessage({
      address: other.address,
      chainId: 8453,
      domain: 'demo.blockwarden.dev',
      nonce,
      uri: 'https://demo.blockwarden.dev',
      version: '1',
      issuedAt: new Date(nowMs),
      expirationTime: new Date(nowMs + 120_000),
    } as never)
    const signature = await other.signMessage({ message })
    const result = await handleVerify(deps, event({ message, signature }))
    expect(result.status).toBe(401)
    expect((result.body as { error: { code: string } }).error.code).toBe('siwe_wallet')
    // the nonce survives a refusal that never looked at a signature, so an allowlisted user is not
    // denied a nonce someone else burned
    expect(await deps.store.consume(nonce, nowMs)).toBe(true)
  })

  it('refuses a body that is not JSON', async () => {
    const result = await handleVerify(deps, {
      version: '2.0',
      routeKey: 'POST /v1/auth/siwe/verify',
      headers: {},
      body: 'nope',
    } as never)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_json')
  })

  it('clears the cookie on logout', () => {
    const result = handleLogout({} as never)
    expect(result.cookies).toEqual(['bw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'])
  })
})
