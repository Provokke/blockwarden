import { describe, expect, it, vi } from 'vitest'
import { acceptOutbound, outboundRequestSchema } from '../../src/outbound.js'
import { fakeQueue, fakeStore } from './fakes.js'

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'merchant-42:invoice-1001:paid',
  url: 'https://merchant.example.com/hooks',
  secretParameter: '/billwarden/merchants/42/secret',
  body: { type: 'invoice.paid', data: { invoiceId: '1001' } },
  ...overrides,
})

const deps = () => {
  const { store, items } = fakeStore()
  const { queue, sent } = fakeQueue()
  const log = vi.fn()
  return {
    deps: { store: store as never, queue, now: () => new Date(1_000), log, allowedSecretPrefixes: ['/billwarden/'] },
    items,
    sent,
    log,
  }
}

const message = (body: unknown, messageId = 'm1') => ({ messageId, body: JSON.stringify(body) })

describe('the request schema', () => {
  it('takes the whole shape', () => {
    expect(
      outboundRequestSchema.safeParse(request({ signatureHeader: 'Billwarden-Signature', eventId: 'evt_1' })).success,
    ).toBe(true)
  })

  it('takes a body that is already a string', () => {
    expect(outboundRequestSchema.safeParse(request({ body: '{"type":"invoice.paid"}' })).success).toBe(true)
  })

  it('refuses a URL the destination rules refuse', () => {
    expect(outboundRequestSchema.safeParse(request({ url: 'http://merchant.example.com/hooks' })).success).toBe(false)
    expect(outboundRequestSchema.safeParse(request({ url: 'https://169.254.169.254/' })).success).toBe(false)
  })

  it('refuses a missing request id, a missing secret and an unknown key', () => {
    expect(outboundRequestSchema.safeParse(request({ requestId: '' })).success).toBe(false)
    expect(outboundRequestSchema.safeParse(request({ secretParameter: undefined })).success).toBe(false)
    expect(outboundRequestSchema.safeParse(request({ extra: 1 })).success).toBe(false)
  })

  it('refuses a header name that is not one', () => {
    expect(outboundRequestSchema.safeParse(request({ signatureHeader: 'has space' })).success).toBe(false)
  })

  // the caller chooses these names, so they go through the same guard a webhook action's own header names do:
  // a reserved header would either be overwritten by the sender or steer the connection to the wrong host
  it('refuses a header name the sender computes for itself, or that frames the message', () => {
    expect(outboundRequestSchema.safeParse(request({ signatureHeader: 'Host' })).success).toBe(false)
    expect(outboundRequestSchema.safeParse(request({ deliveryHeader: 'content-length' })).success).toBe(false)
  })

  // one name for both headers means one of them wins the object literal; if it is the signature that loses,
  // the request would go out unsigned
  it('refuses two header names that are the same header, case-insensitively', () => {
    expect(
      outboundRequestSchema.safeParse(request({ signatureHeader: 'X-Sig', deliveryHeader: 'X-Sig' })).success,
    ).toBe(false)
    expect(
      outboundRequestSchema.safeParse(request({ signatureHeader: 'X-Sig', deliveryHeader: 'x-sig' })).success,
    ).toBe(false)
    // a name left out still counts: the sender falls back to its default
    expect(outboundRequestSchema.safeParse(request({ deliveryHeader: 'X-Blockwarden-Signature' })).success).toBe(false)
    expect(
      outboundRequestSchema.safeParse(request({ signatureHeader: 'X-Sig', deliveryHeader: 'X-Dlv' })).success,
    ).toBe(true)
  })
})

describe('acceptOutbound', () => {
  it('creates one delivery and enqueues it', async () => {
    const d = deps()
    expect(await acceptOutbound(d.deps, [message(request())])).toEqual({ batchItemFailures: [] })
    expect(d.items.size).toBe(1)
    expect(d.sent).toHaveLength(1)
    const delivery = [...d.items.values()][0]!
    expect(delivery.subject).toBe('OUTBOUND#merchant-42:invoice-1001:paid')
    expect(delivery.channel).toBe('webhook')
    expect(delivery.target).toMatchObject({
      channel: 'webhook',
      url: 'https://merchant.example.com/hooks',
      secretParameter: '/billwarden/merchants/42/secret',
    })
    expect(JSON.parse(delivery.payload)).toEqual({ type: 'invoice.paid', data: { invoiceId: '1001' } })
  })

  it('signs a string body byte for byte, including its spacing', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request({ body: '{ "a" : 1 }' }))])
    expect([...d.items.values()][0]!.payload).toBe('{ "a" : 1 }')
  })

  it('creates the same delivery once for a request sent twice', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request())])
    await acceptOutbound(d.deps, [
      message(request({ body: { type: 'invoice.paid', data: { invoiceId: 'different' } } })),
    ])
    expect(d.items.size).toBe(1)
    expect(d.sent).toHaveLength(1)
    // the first body is the one that was accepted; the second is logged and dropped
    expect(JSON.parse([...d.items.values()][0]!.payload).data.invoiceId).toBe('1001')
  })

  it("carries the caller's event id into the target", async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request({ eventId: 'evt_9' }))])
    expect([...d.items.values()][0]!.target).toMatchObject({ eventId: 'evt_9' })
  })

  it('refuses a secret parameter outside the allowed prefixes', async () => {
    const d = deps()
    const response = await acceptOutbound(d.deps, [message(request({ secretParameter: '/other/service/secret' }))])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(0)
    expect(d.log).toHaveBeenCalledWith(
      'outbound request refused',
      expect.objectContaining({ reason: expect.stringContaining('prefix') }),
      'error',
    )
  })

  it('refuses a body above the size limit', async () => {
    const d = deps()
    const response = await acceptOutbound(d.deps, [message(request({ body: 'x'.repeat(64 * 1024 + 1) }))])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(0)
  })

  it('reports a malformed message so the queue dead-letters it, and keeps the rest of the batch', async () => {
    const d = deps()
    const response = await acceptOutbound(d.deps, [{ messageId: 'bad', body: 'not json' }, message(request(), 'good')])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }])
    expect(d.items.size).toBe(1)
  })

  it('never logs the body or the secret value', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [
      { messageId: 'bad', body: JSON.stringify(request({ url: 'http://x.example.com/' })) },
    ])
    const logged = JSON.stringify(d.log.mock.calls)
    expect(logged).not.toContain('invoiceId')
  })
})
