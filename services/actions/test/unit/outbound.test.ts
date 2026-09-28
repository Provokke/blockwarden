import { describe, expect, it, vi } from 'vitest'
import { acceptOutbound, outboundRequestSchema } from '../../src/outbound.js'
import { MAX_ERROR_CHARACTERS } from '../../src/records.js'
import { fakeQueue, fakeStore } from './fakes.js'

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'merchant-42:invoice-1001:paid',
  url: 'https://merchant.example.com/hooks',
  secretParameter: '/billwarden/merchants/42/secret',
  body: { type: 'invoice.paid', data: { invoiceId: '1001' } },
  ...overrides,
})

const deps = (allowedSecretPrefixes: readonly string[] = ['/billwarden/']) => {
  const { store, items } = fakeStore()
  const { queue, sent } = fakeQueue()
  const log = vi.fn()
  return {
    deps: { store, queue, now: () => new Date(1_000), log, allowedSecretPrefixes },
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

  // this is the field that decides which secret bytes are read, on the surface a third party writes, so it is
  // held to the same SSM name rule a rule's own webhook action is held to, not to a looser local one
  it('holds the secret parameter to the same name rule a rule action uses', () => {
    for (const secretParameter of [
      '/billwarden/../gaswarden/secret',
      '/billwarden/a b',
      '/billwarden/a\nb',
      `/billwarden${'/a'.repeat(30)}`,
      'billwarden/secret',
      '/billwarden/',
    ]) {
      expect(outboundRequestSchema.safeParse(request({ secretParameter })).success, secretParameter).toBe(false)
    }
  })

  it('refuses an event id that is not printable ASCII', () => {
    expect(outboundRequestSchema.safeParse(request({ eventId: 'evt_01J8Z' })).success).toBe(true)
    // a newline would make Node throw on the header write, which the sender reads as worth retrying
    expect(outboundRequestSchema.safeParse(request({ eventId: 'evt\n1' })).success).toBe(false)
    expect(outboundRequestSchema.safeParse(request({ eventId: 'evté' })).success).toBe(false)
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

  // the contract Billwarden reads: the delivery is keyed on the request id alone, so the same id is the same
  // delivery however the destination happens to be spelt
  it('treats a repeat that only spells the same destination differently as the same delivery', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request())])
    const response = await acceptOutbound(d.deps, [
      message(
        request({
          url: 'https://merchant.example.com/hooks?',
          signatureHeader: 'X-BLOCKWARDEN-SIGNATURE',
          deliveryHeader: 'x-blockwarden-delivery',
        }),
        'm2',
      ),
    ])
    expect(response.batchItemFailures).toEqual([])
    expect(d.items.size).toBe(1)
    expect(d.sent).toHaveLength(1)
  })

  it('refuses a repeat that points the same request id at another URL', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request())])
    const response = await acceptOutbound(d.deps, [message(request({ url: 'https://other.example.com/hooks' }), 'm2')])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }])
    expect(d.items.size).toBe(1)
    expect(d.sent).toHaveLength(1)
    expect(d.log).toHaveBeenCalledWith(
      'outbound request refused',
      expect.objectContaining({ reason: expect.stringContaining('another destination') }),
      'error',
    )
  })

  it('refuses a repeat that points the same request id at another secret', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [message(request())])
    const response = await acceptOutbound(d.deps, [
      message(request({ secretParameter: '/billwarden/merchants/99/secret' }), 'm2'),
    ])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }])
    expect(d.items.size).toBe(1)
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

  // a prefix is a path, not a string: /billwarden must not admit /billwardenX, which is another tenant
  it('does not let a prefix written without its trailing slash admit a sibling', async () => {
    const d = deps(['/billwarden'])
    const response = await acceptOutbound(d.deps, [message(request({ secretParameter: '/billwardenX/secret' }))])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(0)
    // and the prefix it was meant to name still works
    expect((await acceptOutbound(d.deps, [message(request(), 'm2')])).batchItemFailures).toEqual([])
    expect(d.items.size).toBe(1)
  })

  it('refuses a body above the size limit', async () => {
    const d = deps()
    const response = await acceptOutbound(d.deps, [message(request({ body: 'x'.repeat(64 * 1024 + 1) }))])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(0)
  })

  // the reason is built from what the caller sent, so a caller can decide how long the log line is unless the
  // same cap every other error string in the package uses is applied to it
  it('keeps the refusal reason inside the error cap, however long the caller made it', async () => {
    const d = deps()
    const body = JSON.stringify({ ...request(), ['k'.repeat(5_000)]: 1 })
    await acceptOutbound(d.deps, [{ messageId: 'm1', body }])
    const reason = (d.log.mock.calls[0]![1] as { reason: string }).reason
    expect(reason.length).toBeLessThanOrEqual(MAX_ERROR_CHARACTERS + 3)
  })

  it('reports a malformed message so the queue dead-letters it, and keeps the rest of the batch', async () => {
    const d = deps()
    const response = await acceptOutbound(d.deps, [{ messageId: 'bad', body: 'not json' }, message(request(), 'good')])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }])
    expect(d.items.size).toBe(1)
  })

  it('reports the message back when the store will not take it', async () => {
    const d = deps()
    const failing = {
      ...d.deps,
      store: {
        ...d.deps.store,
        create: async () => {
          throw new Error('dynamodb is unavailable')
        },
      },
    }
    const response = await acceptOutbound(failing, [message(request())])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(0)
    expect(d.log).toHaveBeenCalledWith(
      'outbound request could not be stored',
      expect.objectContaining({ error: 'dynamodb is unavailable' }),
      'error',
    )
  })

  // the item is written before the message is sent, so a queue failure leaves a delivery nothing has queued;
  // it is still due immediately, which is what the reaper sweeps for
  it('reports the message back when the queue will not take it, and leaves the delivery due', async () => {
    const d = deps()
    const failing = {
      ...d.deps,
      queue: {
        send: async () => {
          throw new Error('sqs is unavailable')
        },
      },
    }
    const response = await acceptOutbound(failing, [message(request())])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.items.size).toBe(1)
    const delivery = [...d.items.values()][0]!
    expect(delivery.status).toBe('pending')
    expect(delivery.nextAttemptAt).toBe(1_000)
  })

  it('treats the redelivered message after a failed enqueue as already accepted', async () => {
    const d = deps()
    const failing = {
      ...d.deps,
      queue: {
        send: async () => {
          throw new Error('sqs is unavailable')
        },
      },
    }
    await acceptOutbound(failing, [message(request())])
    const response = await acceptOutbound(d.deps, [message(request(), 'm1-again')])
    expect(response.batchItemFailures).toEqual([])
    expect(d.items.size).toBe(1)
    // the retry does not queue it either: the item is the reaper's to pick up, not this handler's to re-send
    expect(d.sent).toHaveLength(0)
    expect(d.log).toHaveBeenCalledWith('outbound request already accepted', {
      requestId: 'merchant-42:invoice-1001:paid',
    })
  })

  it('never logs the body or the secret value', async () => {
    const d = deps()
    await acceptOutbound(d.deps, [
      { messageId: 'bad', body: JSON.stringify(request({ url: 'http://x.example.com/' })) },
      // the refusal that is about the secret parameter is the one most tempting to quote it back
      { messageId: 'outside', body: JSON.stringify(request({ secretParameter: '/other/service/secret' })) },
    ])
    const logged = JSON.stringify(d.log.mock.calls)
    expect(logged).not.toContain('invoiceId')
    expect(logged).not.toContain('/billwarden/merchants/42/secret')
    expect(logged).not.toContain('/other/service/secret')
  })
})
