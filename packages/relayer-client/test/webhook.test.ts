import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
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
})

describe('isTxEvent and parseTx', () => {
  it('narrows tx events and turns their amounts back into bigints', async () => {
    const payload = event('tx.confirmed', { value: '1000000000000000000000', gasLimit: '21000' })
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
})
