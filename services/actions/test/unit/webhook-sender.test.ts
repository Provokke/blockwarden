import { DEFAULT_DELIVERY_HEADER, DEFAULT_SIGNATURE_HEADER } from '@blockwarden/core'
import { DELIVERY_HEADER, SIGNATURE_HEADER, verifyWebhook } from '@blockwarden/relayer-client'
import { describe, expect, it, vi } from 'vitest'
import { DestinationError, type HttpAnswer, type Resolved } from '../../src/destination.js'
import { sendWebhook, signatureFor } from '../../src/senders/webhook.js'
import type { DeliveryRecord } from '../../src/records.js'

const payload = JSON.stringify({ id: 'dlv_1', type: 'match.final', createdAt: 'now', specVersion: 1, data: {} })

const delivery = (target: Partial<Extract<DeliveryRecord['target'], { channel: 'webhook' }>> = {}): DeliveryRecord => ({
  deliveryId: 'dlv_1',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'webhook',
  target: { channel: 'webhook', url: 'https://example.com/hook', secretParameter: '/bw/secret', ...target },
  payload,
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

const resolved: Resolved = {
  url: new URL('https://example.com/hook'),
  host: 'example.com',
  address: '93.184.216.34',
  family: 4,
  port: 443,
}

const deps = (answer: HttpAnswer | Error, secrets = ['s1']) => {
  const post = vi.fn(
    async (
      _target: Resolved,
      _body: string,
      _headers: Record<string, string>,
      _options?: { timeoutMs?: number; deadlineMs?: number },
    ) => {
      if (answer instanceof Error) throw answer
      return answer
    },
  )
  // both fakes record what they were asked for, so a test can prove which parameter and which URL the sender
  // actually passed rather than only that it passed something
  const asked: string[] = []
  const resolve = vi.fn(async (_raw: string) => resolved)
  const log = vi.fn()
  return {
    deps: {
      secrets: {
        read: async (name: string) => {
          asked.push(name)
          return secrets
        },
      },
      now: () => 1_789_000_000_000,
      log,
      resolve,
      post,
    },
    post,
    resolve,
    asked,
    log,
  }
}

describe('signing', () => {
  it('puts one v1 per secret under one timestamp, and either verifies', async () => {
    const header = await signatureFor(payload, ['new', 'old'], 1_789_000_000_000)
    expect(header.match(/v1=/g)).toHaveLength(2)
    expect(header.match(/t=/g)).toHaveLength(1)
    for (const secret of ['new', 'old']) {
      await expect(
        verifyWebhook({ payload, signature: header, secret, nowMs: 1_789_000_000_000 }),
      ).resolves.toBeTruthy()
    }
  })
})

describe('sendWebhook', () => {
  it('posts the stored payload with the default header names', async () => {
    const d = deps({ statusCode: 200, body: 'ok' })
    expect(await sendWebhook(d.deps, delivery())).toEqual({ kind: 'delivered', statusCode: 200 })
    const [, body, headers] = d.post.mock.calls[0]!
    expect(body).toBe(payload)
    expect(Object.keys(headers)).toHaveLength(2)
    expect(headers[DELIVERY_HEADER]).toBe('dlv_1')
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('names the two headers what the published client and the rule schema name them', () => {
    expect(DEFAULT_SIGNATURE_HEADER).toBe(SIGNATURE_HEADER)
    expect(DEFAULT_DELIVERY_HEADER).toBe(DELIVERY_HEADER)
  })

  it('refuses to send when both header names are the same header, rather than sending unsigned', async () => {
    for (const target of [
      { signatureHeader: 'X-Sig', deliveryHeader: 'X-Sig' },
      // a case-differing pair is the same header to a receiver
      { signatureHeader: 'X-Sig', deliveryHeader: 'x-sig' },
      // the shape a stored rule can already have: the signature left at its default, the delivery id on top of it
      { deliveryHeader: SIGNATURE_HEADER },
      { deliveryHeader: 'X-Blockwarden-Signature' },
      { signatureHeader: DELIVERY_HEADER },
    ]) {
      const d = deps({ statusCode: 200, body: '' })
      const outcome = await sendWebhook(d.deps, delivery(target))
      expect(outcome, JSON.stringify(target)).toMatchObject({ kind: 'permanent' })
      expect(outcome.kind === 'permanent' && outcome.error).toContain('same header')
      expect(d.post).not.toHaveBeenCalled()
      // an operator has to hear about a rule that cannot be delivered at all
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('header'), expect.anything(), 'warn')
    }
  })

  it('reads the parameter the action names, and the default only when the action names none', async () => {
    const named = deps({ statusCode: 200, body: '' })
    await sendWebhook({ ...named.deps, defaultWebhookSecretParameter: '/bw/default' }, delivery())
    expect(named.asked).toEqual(['/bw/secret'])
    const unnamed = deps({ statusCode: 200, body: '' })
    await sendWebhook(
      { ...unnamed.deps, defaultWebhookSecretParameter: '/bw/default' },
      delivery({ secretParameter: undefined }),
    )
    expect(unnamed.asked).toEqual(['/bw/default'])
  })

  it("falls back to the default when the action's parameter is empty, rather than dead-lettering", async () => {
    const d = deps({ statusCode: 200, body: '' })
    const outcome = await sendWebhook(
      { ...d.deps, defaultWebhookSecretParameter: '/bw/default' },
      delivery({ secretParameter: '' }),
    )
    expect(outcome.kind).toBe('delivered')
    expect(d.asked).toEqual(['/bw/default'])
  })

  it("resolves the delivery's own URL, which is the string the guard judges", async () => {
    const d = deps({ statusCode: 200, body: '' })
    await sendWebhook(d.deps, delivery({ url: 'https://elsewhere.example/other-hook' }))
    expect(d.resolve).toHaveBeenCalledWith('https://elsewhere.example/other-hook')
  })

  it('calls a parameter that holds no secret a configuration fault, not an unreachable destination', async () => {
    const d = deps({ statusCode: 200, body: '' }, [])
    const outcome = await sendWebhook(d.deps, delivery())
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).not.toContain('could not be reached')
    expect(outcome.kind === 'permanent' && outcome.error).toContain('without a secret')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('uses the header names the action chose', async () => {
    const d = deps({ statusCode: 204, body: '' })
    await sendWebhook(
      d.deps,
      delivery({ signatureHeader: 'Billwarden-Signature', deliveryHeader: 'Billwarden-Delivery' }),
    )
    const [, , headers] = d.post.mock.calls[0]!
    expect(headers['Billwarden-Signature']).toBeDefined()
    expect(headers['Billwarden-Delivery']).toBe('dlv_1')
    expect(headers[SIGNATURE_HEADER]).toBeUndefined()
  })

  it('calls a 2xx delivered and a 3xx permanent, because a redirect is never followed', async () => {
    expect((await sendWebhook(deps({ statusCode: 201, body: '' }).deps, delivery())).kind).toBe('delivered')
    const redirect = await sendWebhook(deps({ statusCode: 302, body: '' }).deps, delivery())
    expect(redirect.kind).toBe('permanent')
    expect(redirect.kind === 'permanent' && redirect.error).toContain('redirect')
  })

  it('calls a 4xx permanent and a 429 a retry', async () => {
    const gone = await sendWebhook(deps({ statusCode: 410, body: 'gone' }).deps, delivery())
    expect(gone).toMatchObject({ kind: 'permanent', statusCode: 410 })
    const throttled = await sendWebhook(deps({ statusCode: 429, body: '', retryAfterSeconds: 7 }).deps, delivery())
    expect(throttled).toMatchObject({ kind: 'retry', statusCode: 429, afterSeconds: 7 })
  })

  it('calls a 5xx and a connection failure a retry', async () => {
    expect((await sendWebhook(deps({ statusCode: 503, body: '' }).deps, delivery())).kind).toBe('retry')
    expect((await sendWebhook(deps(new Error('socket hang up')).deps, delivery())).kind).toBe('retry')
  })

  it('keeps at most 256 characters of the answer in the error', async () => {
    const outcome = await sendWebhook(deps({ statusCode: 500, body: 'x'.repeat(3_000) }).deps, delivery())
    expect(outcome.kind === 'retry' && outcome.error.length).toBeLessThanOrEqual(300)
  })

  it('calls a refused destination permanent and an unresolvable one a retry', async () => {
    const refusedDeps = {
      ...deps({ statusCode: 200, body: '' }).deps,
      resolve: async () => {
        throw new DestinationError('the destination is refused: the address is inside 10.0.0.0/8')
      },
    }
    expect((await sendWebhook(refusedDeps as never, delivery())).kind).toBe('permanent')
    const unresolvedDeps = {
      ...deps({ statusCode: 200, body: '' }).deps,
      resolve: async () => {
        throw new DestinationError('the destination could not be resolved: EAI_AGAIN', true)
      },
    }
    expect((await sendWebhook(unresolvedDeps as never, delivery())).kind).toBe('retry')
  })

  it('fails permanently when no secret parameter is configured anywhere', async () => {
    const d = deps({ statusCode: 200, body: '' })
    const outcome = await sendWebhook(d.deps, delivery({ secretParameter: undefined }))
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('no webhook secret')
    expect(d.post).not.toHaveBeenCalled()
  })

  it("falls back to the module's secret parameter when the action names none", async () => {
    const d = deps({ statusCode: 200, body: '' })
    const outcome = await sendWebhook(
      { ...d.deps, defaultWebhookSecretParameter: '/bw/default' } as never,
      delivery({ secretParameter: undefined }),
    )
    expect(outcome.kind).toBe('delivered')
  })

  it('calls a secret that cannot be read a retry, not a permanent failure', async () => {
    const d = deps({ statusCode: 200, body: '' })
    const broken = {
      ...d.deps,
      secrets: {
        read: async () => {
          throw new Error('ThrottlingException')
        },
      },
    }
    expect((await sendWebhook(broken as never, delivery())).kind).toBe('retry')
  })
})
