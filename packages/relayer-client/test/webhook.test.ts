import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { RelayerTxBody } from '../src/types.js'
import { isTxEvent, parseTx, signWebhook, verifyWebhook, WebhookVerificationError } from '../src/webhook.js'

const NOW = 1_800_000_000_000
const event = (type: string, data: unknown = {}) =>
  JSON.stringify({ id: 'del_1', type, createdAt: '2026-09-17T00:00:00Z', data })

describe('signWebhook', () => {
  it('matches an HMAC-SHA256 over "<t>.<payload>" computed by node:crypto', async () => {
    const payload = event('tx.mined')
    const header = await signWebhook({ payload, secret: 'whsec', nowMs: NOW })
    const t = NOW / 1000
    expect(header).toBe(`t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${payload}`).digest('hex')}`)
  })
})

describe('verifyWebhook', () => {
  it('accepts what signWebhook signed and rejects any change to the payload', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), fc.string(), fc.nat({ max: 1_000 }), async (secret, note, flip) => {
        const payload = event('tx.confirmed', { note })
        const signature = await signWebhook({ payload, secret, nowMs: NOW })
        await expect(verifyWebhook({ payload, signature, secret, nowMs: NOW })).resolves.toMatchObject({ id: 'del_1' })

        const i = flip % payload.length
        const tampered = `${payload.slice(0, i)}${payload[i] === 'x' ? 'y' : 'x'}${payload.slice(i + 1)}`
        await expect(verifyWebhook({ payload: tampered, signature, secret, nowMs: NOW })).rejects.toThrow(
          WebhookVerificationError,
        )
      }),
      { numRuns: 50 },
    )
  })

  it('rejects the wrong secret and accepts any secret in a rotation list', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 'new', nowMs: NOW })
    await expect(verifyWebhook({ payload, signature, secret: 'old', nowMs: NOW })).rejects.toThrow(
      /no signature matches/,
    )
    await expect(verifyWebhook({ payload, signature, secret: ['old', 'new'], nowMs: NOW })).resolves.toBeDefined()
  })

  it('accepts a header with several v1 values when one matches', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    const withOld = `${signature},v1=${'0'.repeat(64)}`
    await expect(verifyWebhook({ payload, signature: withOld, secret: 's', nowMs: NOW })).resolves.toBeDefined()
  })

  it('allows the tolerance in both directions and no further', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    for (const offset of [-300_000, 300_000]) {
      await expect(verifyWebhook({ payload, signature, secret: 's', nowMs: NOW + offset })).resolves.toBeDefined()
    }
    for (const offset of [-301_000, 301_000]) {
      await expect(verifyWebhook({ payload, signature, secret: 's', nowMs: NOW + offset })).rejects.toThrow(
        /300 seconds/,
      )
    }
  })

  it.each([
    ['a missing header', undefined, /missing/],
    ['no timestamp', `v1=${'a'.repeat(64)}`, /no timestamp/],
    ['no v1 value', `t=${NOW / 1000}`, /no v1/],
    ['a v1 value that is not 64 hex characters', `t=${NOW / 1000},v1=abc`, /no v1/],
  ])('rejects %s', async (_, signature, message) => {
    await expect(verifyWebhook({ payload: event('x'), signature, secret: 's', nowMs: NOW })).rejects.toThrow(message)
  })

  it('rejects a signed payload that is not JSON or not an event', async () => {
    for (const [payload, message] of [
      ['not json', /not JSON/],
      ['{"type":"tx.mined"}', /not a Blockwarden event/],
    ] as const) {
      const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
      await expect(verifyWebhook({ payload, signature, secret: 's', nowMs: NOW })).rejects.toThrow(message)
    }
  })

  it('rejects a non-finite tolerance instead of accepting every timestamp', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    for (const toleranceSeconds of [NaN, Infinity, -Infinity]) {
      await expect(verifyWebhook({ payload, signature, secret: 's', nowMs: NOW, toleranceSeconds })).rejects.toThrow(
        /toleranceSeconds must be a finite number/,
      )
    }
  })

  it('rejects a negative tolerance', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    await expect(verifyWebhook({ payload, signature, secret: 's', nowMs: NOW, toleranceSeconds: -1 })).rejects.toThrow(
      /toleranceSeconds must be a finite number/,
    )
  })

  it('rejects a non-finite nowMs instead of accepting every timestamp', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    for (const nowMs of [NaN, Infinity, -Infinity]) {
      await expect(verifyWebhook({ payload, signature, secret: 's', nowMs })).rejects.toThrow(
        /nowMs must be a finite number/,
      )
    }
  })

  it('rejects an empty secret instead of throwing a raw DOMException', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 'real', nowMs: NOW })
    await expect(verifyWebhook({ payload, signature, secret: '', nowMs: NOW })).rejects.toThrow(
      /webhook secret must not be empty/,
    )
  })

  it('rejects an empty secret in a rotation list even when another entry would match', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 'real', nowMs: NOW })
    await expect(verifyWebhook({ payload, signature, secret: ['', 'real'], nowMs: NOW })).rejects.toThrow(
      /webhook secret must not be empty/,
    )
  })

  it('rejects an empty secret list', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 'real', nowMs: NOW })
    await expect(verifyWebhook({ payload, signature, secret: [], nowMs: NOW })).rejects.toThrow(
      /webhook secret must not be empty/,
    )
  })

  it('rejects a non-numeric t in the header', async () => {
    await expect(
      verifyWebhook({ payload: event('x'), signature: `t=abc,v1=${'a'.repeat(64)}`, secret: 's', nowMs: NOW }),
    ).rejects.toThrow(/no timestamp/)
  })

  it('tolerates whitespace around the parts of the header', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    const spaced = signature
      .split(',')
      .map((part) => ` ${part} `)
      .join(' , ')
    await expect(verifyWebhook({ payload, signature: spaced, secret: 's', nowMs: NOW })).resolves.toBeDefined()
  })

  it('rejects a tampered value inside the JSON with the specific no-match reason', async () => {
    const payload = event('tx.mined', { note: 'hello' })
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    const tampered = payload.replace('hello', 'HELLO')
    await expect(verifyWebhook({ payload: tampered, signature, secret: 's', nowMs: NOW })).rejects.toThrow(
      'no signature matches the payload',
    )
  })
})

const TX: RelayerTxBody = {
  txId: 'tx-1',
  kind: 'relay',
  signerId: 'billing',
  chainId: 84532,
  from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  to: '0x000000000000000000000000000000000000dEaD',
  data: '0x',
  value: '1000000000000000000000',
  gasLimit: '21000',
  status: 'confirmed',
  nonce: 4,
  hash: `0x${'ab'.repeat(32)}`,
  blockNumber: 100,
  blockHash: `0x${'cd'.repeat(32)}`,
  receiptStatus: 'success',
  error: null,
  fillerTxId: null,
  idempotencyKey: 'charge-1',
  reference: null,
  dependsOn: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
}

describe('isTxEvent and parseTx', () => {
  it('narrows tx events and turns their amounts back into bigints', async () => {
    const payload = event('tx.confirmed', TX)
    const verified = await verifyWebhook({
      payload,
      signature: await signWebhook({ payload, secret: 's', nowMs: NOW }),
      secret: 's',
      nowMs: NOW,
    })
    expect(isTxEvent(verified)).toBe(true)
    expect(isTxEvent({ ...verified, type: 'match.final' })).toBe(false)
    if (isTxEvent(verified)) expect(parseTx(verified.data).value).toBe(10n ** 21n)
  })

  it('refuses an event whose type is not a known status or whose data is not a transaction', () => {
    const base = { id: 'del_1', createdAt: '2026-09-17T00:00:00Z' }
    expect(isTxEvent({ ...base, type: 'tx.mined', data: TX })).toBe(true)
    expect(isTxEvent({ ...base, type: 'tx.lost', data: TX })).toBe(false)
    expect(isTxEvent({ ...base, type: 'tx.', data: TX })).toBe(false)
    for (const data of [
      undefined,
      null,
      'tx',
      { ...TX, value: undefined },
      { ...TX, value: '' },
      { ...TX, gasLimit: '0x10' },
      { ...TX, txId: undefined },
      { ...TX, chainId: '84532' },
      { ...TX, status: 'lost' },
      { ...TX, hash: 7 },
    ]) {
      const e = { ...base, type: 'tx.mined', data }
      expect(isTxEvent(e)).toBe(false)
    }
  })
})

describe('secrets that are not strings', () => {
  it('refuses to sign with an empty secret', async () => {
    await expect(signWebhook({ payload: '{}', secret: '', nowMs: NOW })).rejects.toThrow(/must not be empty/)
  })

  it('throws WebhookVerificationError, not TypeError, for a secret or list entry that is not a string', async () => {
    const payload = event('tx.mined')
    const signature = await signWebhook({ payload, secret: 's', nowMs: NOW })
    for (const secret of [42, undefined, ['s', 7], [null]]) {
      await expect(verifyWebhook({ payload, signature, secret: secret as never, nowMs: NOW })).rejects.toThrow(
        WebhookVerificationError,
      )
    }
  })
})
