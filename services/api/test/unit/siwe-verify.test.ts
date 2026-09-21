import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { describe, expect, it } from 'vitest'
import { checkSiweMessage, type SiweSettings } from '../../src/siwe.js'

const address = '0x1111111111111111111111111111111111111111' as const
const now = 1_770_000_000_000
const settings: SiweSettings = {
  domain: 'demo.blockwarden.dev',
  origin: 'https://demo.blockwarden.dev',
  chainIds: [8453, 42161],
  allowedWallets: [address],
}

function message(over: Record<string, unknown> = {}) {
  const text = createSiweMessage({
    address,
    chainId: 8453,
    domain: 'demo.blockwarden.dev',
    nonce: 'abcd1234',
    uri: 'https://demo.blockwarden.dev',
    version: '1',
    issuedAt: new Date(now),
    expirationTime: new Date(now + 300_000),
    ...over,
  } as never)
  return parseSiweMessage(text)
}

describe('checkSiweMessage', () => {
  it('accepts a message for the configured domain, origin, chain and wallet', () => {
    expect(checkSiweMessage(message(), settings, now)).toEqual({
      ok: true,
      address,
      chainId: 8453,
      nonce: 'abcd1234',
    })
  })

  it('refuses another domain', () => {
    const outcome = checkSiweMessage(message({ domain: 'evil.example' }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_domain' })
  })

  it('refuses a uri pointing somewhere else, which viem does not check', () => {
    const outcome = checkSiweMessage(message({ uri: 'https://evil.example/callback' }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_uri' })
  })

  it('refuses a uri that merely starts with the origin', () => {
    const outcome = checkSiweMessage(message({ uri: 'https://demo.blockwarden.dev.evil.example' }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_uri' })
  })

  it('refuses a non-http uri even when it and a non-http configured origin both parse to "null"', () => {
    // the URL standard makes .origin the literal string "null" for a scheme it doesn't special-case, so two
    // different non-http schemes would compare equal unless both are required to be http or https first
    const nonHttpOrigin: SiweSettings = { ...settings, origin: 'app://blockwarden' }
    const outcome = checkSiweMessage(message({ uri: 'evil://anything' }), nonHttpOrigin, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_uri' })
  })

  it('refuses a chain the deployment does not monitor, which viem does not check', () => {
    const outcome = checkSiweMessage(message({ chainId: 1 }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_chain' })
  })

  it('refuses a wallet that is not on the allowlist', () => {
    const outcome = checkSiweMessage(message({ address: '0x9999999999999999999999999999999999999999' }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_wallet' })
  })

  it('compares wallets by value, not by case', () => {
    const lower: SiweSettings = { ...settings, allowedWallets: [address.toLowerCase() as never] }
    expect(checkSiweMessage(message(), lower, now)).toEqual({
      ok: true,
      address,
      chainId: 8453,
      nonce: 'abcd1234',
    })
  })

  it('refuses an expired message', () => {
    expect(checkSiweMessage(message(), settings, now + 300_001)).toMatchObject({ ok: false, code: 'siwe_expired' })
  })

  it('refuses a message with no expiry at all, so a signature cannot be spent for ever', () => {
    const text = createSiweMessage({
      address,
      chainId: 8453,
      domain: 'demo.blockwarden.dev',
      nonce: 'abcd1234',
      uri: 'https://demo.blockwarden.dev',
      version: '1',
      issuedAt: new Date(now),
    } as never)
    expect(checkSiweMessage(parseSiweMessage(text), settings, now)).toMatchObject({
      ok: false,
      code: 'siwe_expired',
    })
  })

  it('refuses an expiry further out than the nonce lives, which would be a lie about the window', () => {
    const outcome = checkSiweMessage(message({ expirationTime: new Date(now + 3_600_000) }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_expiry_too_far' })
  })

  it('refuses a message not yet valid', () => {
    const outcome = checkSiweMessage(message({ notBefore: new Date(now + 60_000) }), settings, now)
    expect(outcome).toMatchObject({ ok: false, code: 'siwe_not_yet_valid' })
  })

  it('refuses an empty allowlist rather than letting everyone in', () => {
    const empty: SiweSettings = { ...settings, allowedWallets: [] }
    expect(checkSiweMessage(message(), empty, now)).toMatchObject({ ok: false, code: 'siwe_wallet' })
  })

  it('refuses a message missing its uri as malformed, not as an unrelated uri mismatch', () => {
    const text = createSiweMessage({
      address,
      chainId: 8453,
      domain: 'demo.blockwarden.dev',
      nonce: 'abcd1234',
      uri: 'https://demo.blockwarden.dev',
      version: '1',
      issuedAt: new Date(now),
      expirationTime: new Date(now + 300_000),
    } as never)
    // parseSiweMessage's suffix fields all come from one match against one regex, so dropping the URI line
    // also drops version, chain ID and nonce - which is exactly the "not a SIWE message" case this guards
    const withoutUri = text.replace(/URI: .+\n/, '')
    expect(checkSiweMessage(parseSiweMessage(withoutUri), settings, now)).toMatchObject({
      ok: false,
      code: 'siwe_malformed',
    })
  })
})
