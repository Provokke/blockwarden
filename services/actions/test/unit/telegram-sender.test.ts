import { describe, expect, it, vi } from 'vitest'
import { sendTelegram } from '../../src/senders/telegram.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { Resolved } from '../../src/destination.js'
import type { SenderDeps } from '../../src/senders/types.js'

const delivery = (): DeliveryRecord => ({
  deliveryId: 'dlv_tg',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'telegram',
  target: { channel: 'telegram', chatId: '-1001234567890' },
  payload: JSON.stringify({
    id: 'dlv_tg',
    type: 'match.final',
    createdAt: 'now',
    specVersion: 1,
    data: { eventName: 'Transfer', chainId: 8453, status: 'final', args: {} },
  }),
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

const resolved: Resolved = {
  url: new URL('https://api.telegram.org/'),
  host: 'api.telegram.org',
  address: '149.154.167.220',
  family: 4,
  port: 443,
}

const deps = (answer: { statusCode: number; body: string }) => {
  const post = vi.fn(
    async (
      _target: Resolved,
      _body: string,
      _headers: Record<string, string>,
      _options?: { timeoutMs?: number; deadlineMs?: number },
    ) => answer,
  )
  const deps: SenderDeps = {
    secrets: { read: async () => ['123456:token'] },
    now: () => 0,
    log: vi.fn(),
    telegramTokenParameter: '/bw/telegram',
    resolve: async () => resolved,
    post,
  }
  return { deps, post }
}

describe('sendTelegram', () => {
  it('posts the rendered text to sendMessage for the chat', async () => {
    const d = deps({ statusCode: 200, body: '{"ok":true,"result":{"message_id":1}}' })
    expect(await sendTelegram(d.deps, delivery())).toEqual({ kind: 'delivered', statusCode: 200 })
    const [target, body] = d.post.mock.calls[0]!
    expect(target.url.pathname).toBe('/bot123456:token/sendMessage')
    expect(JSON.parse(body)).toEqual({
      chat_id: '-1001234567890',
      text: expect.stringContaining('match.final'),
      disable_web_page_preview: true,
    })
  })

  it('never puts the token in an error', async () => {
    const d = deps({ statusCode: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized"}' })
    const outcome = await sendTelegram(d.deps, delivery())
    expect(outcome.kind).toBe('permanent')
    expect(JSON.stringify(outcome)).not.toContain('123456:token')
    expect(outcome.kind === 'permanent' && outcome.error).toContain('Unauthorized')
  })

  it('calls 401 and 404 permanent, because neither a bad token nor a missing chat improves on a retry', async () => {
    expect(
      (
        await sendTelegram(
          deps({ statusCode: 401, body: '{"ok":false,"description":"Unauthorized"}' }).deps,
          delivery(),
        )
      ).kind,
    ).toBe('permanent')
    expect(
      (await sendTelegram(deps({ statusCode: 404, body: '{"ok":false,"description":"Not Found"}' }).deps, delivery()))
        .kind,
    ).toBe('permanent')
    expect(
      (
        await sendTelegram(
          deps({ statusCode: 400, body: '{"ok":false,"description":"chat not found"}' }).deps,
          delivery(),
        )
      ).kind,
    ).toBe('permanent')
  })

  it('honours retry_after on a 429', async () => {
    const d = deps({
      statusCode: 429,
      body: '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":17}}',
    })
    expect(await sendTelegram(d.deps, delivery())).toMatchObject({ kind: 'retry', afterSeconds: 17 })
  })

  it('retries a 5xx and an answer that is not JSON', async () => {
    expect((await sendTelegram(deps({ statusCode: 502, body: '<html>bad gateway' }).deps, delivery())).kind).toBe(
      'retry',
    )
    expect((await sendTelegram(deps({ statusCode: 200, body: 'not json' }).deps, delivery())).kind).toBe('retry')
  })

  it('treats ok:false with a 200 as a failure, because Telegram answers 200 for some refusals', async () => {
    const d = deps({ statusCode: 200, body: '{"ok":false,"description":"chat not found"}' })
    expect((await sendTelegram(d.deps, delivery())).kind).toBe('permanent')
  })

  it('fails permanently when no token parameter is configured', async () => {
    const d = deps({ statusCode: 200, body: '{"ok":true}' })
    const outcome = await sendTelegram({ ...d.deps, telegramTokenParameter: undefined }, delivery())
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(d.post).not.toHaveBeenCalled()
  })
})
