import { describe, expect, it, vi } from 'vitest'
import { DestinationError, type HttpAnswer, type Resolved } from '../../src/destination.js'
import { sendTelegram } from '../../src/senders/telegram.js'
import type { DeliveryRecord } from '../../src/records.js'
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

// every fake records what it was given, so a test can prove which parameter was read, which base was resolved
// and which options were forwarded, rather than only that something was passed
const deps = (
  answer: HttpAnswer | Error,
  options: { secrets?: string[] | Error; extra?: Partial<SenderDeps> } = {},
) => {
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
  const asked: string[] = []
  const resolve = vi.fn(async (_raw: string) => resolved)
  const log = vi.fn()
  const secrets = options.secrets ?? ['123456:token']
  const deps: SenderDeps = {
    secrets: {
      read: async (name: string) => {
        asked.push(name)
        if (secrets instanceof Error) throw secrets
        return secrets
      },
    },
    now: () => 0,
    log,
    telegramTokenParameter: '/bw/telegram',
    resolve,
    post,
    ...options.extra,
  }
  return { deps, post, resolve, asked, log }
}

const answer = (statusCode: number, body: string): HttpAnswer => ({ statusCode, body })

describe('sendTelegram', () => {
  it('posts the rendered text to sendMessage for the chat', async () => {
    const d = deps(answer(200, '{"ok":true,"result":{"message_id":1}}'))
    expect(await sendTelegram(d.deps, delivery())).toEqual({ kind: 'delivered', statusCode: 200 })
    const [target, body] = d.post.mock.calls[0]!
    expect(target.url.pathname).toBe('/bot123456:token/sendMessage')
    expect(JSON.parse(body)).toEqual({
      chat_id: '-1001234567890',
      text: expect.stringContaining('match.final'),
      disable_web_page_preview: true,
    })
    // the parameter the sender read, and the base it resolved, are both the configured ones
    expect(d.asked).toEqual(['/bw/telegram'])
    expect(d.resolve).toHaveBeenCalledWith('https://api.telegram.org/')
  })

  it('resolves the API base it was configured with', async () => {
    const d = deps(answer(200, '{"ok":true}'), { extra: { telegramApiBase: 'https://telegram.example' } })
    await sendTelegram(d.deps, delivery())
    expect(d.resolve).toHaveBeenCalledWith('https://telegram.example/')
  })

  it('forwards the timeout and the deadline it was given, and passes neither when it has neither', async () => {
    const withBoth = deps(answer(200, '{"ok":true}'), { extra: { timeoutMs: 1_234, deadlineMs: 5_678 } })
    await sendTelegram(withBoth.deps, delivery())
    expect(withBoth.post.mock.calls[0]![3]).toEqual({ timeoutMs: 1_234, deadlineMs: 5_678 })
    const withNeither = deps(answer(200, '{"ok":true}'))
    await sendTelegram(withNeither.deps, delivery())
    expect(withNeither.post.mock.calls[0]![3]).toEqual({})
  })

  it('never puts the token in an error', async () => {
    const d = deps(answer(401, '{"ok":false,"error_code":401,"description":"Unauthorized"}'))
    const outcome = await sendTelegram(d.deps, delivery())
    expect(JSON.stringify(outcome)).not.toContain('123456:token')
    expect(outcome.kind !== 'delivered' && outcome.error).toContain('Unauthorized')
  })

  it('retries a 401 and a 404, because both answer our own token and a rotation would lose every alert', async () => {
    const unauthorised = deps(answer(401, '{"ok":false,"description":"Unauthorized"}'))
    expect((await sendTelegram(unauthorised.deps, delivery())).kind).toBe('retry')
    const notFound = deps(answer(404, '{"ok":false,"description":"Not Found"}'))
    expect((await sendTelegram(notFound.deps, delivery())).kind).toBe('retry')
  })

  it('keeps a 400 permanent, because that is the chat id the tenant configured', async () => {
    const d = deps(answer(400, '{"ok":false,"description":"chat not found"}'))
    expect((await sendTelegram(d.deps, delivery())).kind).toBe('permanent')
  })

  it('honours retry_after on a 429', async () => {
    const d = deps(
      answer(429, '{"ok":false,"error_code":429,"description":"Too Many","parameters":{"retry_after":17}}'),
    )
    expect(await sendTelegram(d.deps, delivery())).toMatchObject({ kind: 'retry', afterSeconds: 17 })
  })

  it('retries a 5xx and an answer that is not JSON', async () => {
    expect((await sendTelegram(deps(answer(502, '<html>bad gateway')).deps, delivery())).kind).toBe('retry')
    expect((await sendTelegram(deps(answer(200, 'not json')).deps, delivery())).kind).toBe('retry')
  })

  it('treats ok:false with a 200 as a failure, because Telegram answers 200 for some refusals', async () => {
    const d = deps(answer(200, '{"ok":false,"description":"chat not found"}'))
    expect((await sendTelegram(d.deps, delivery())).kind).toBe('permanent')
  })

  it('fails permanently when no token parameter is configured', async () => {
    const d = deps(answer(200, '{"ok":true}'), { extra: { telegramTokenParameter: undefined } })
    const outcome = await sendTelegram(d.deps, delivery())
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(d.post).not.toHaveBeenCalled()
  })

  it('says so rather than building a URL with nothing in it when the parameter holds no token', async () => {
    const d = deps(answer(200, '{"ok":true}'), { secrets: [] })
    const outcome = await sendTelegram(d.deps, delivery())
    expect(outcome).toMatchObject({ kind: 'retry' })
    expect(outcome.kind !== 'delivered' && outcome.error).toContain('/bw/telegram')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('retries a token the parameter store would not hand over', async () => {
    const d = deps(answer(200, '{"ok":true}'), { secrets: new Error('ThrottlingException') })
    expect((await sendTelegram(d.deps, delivery())).kind).toBe('retry')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('retries when the request itself fails', async () => {
    const d = deps(new Error('socket hang up'))
    const outcome = await sendTelegram(d.deps, delivery())
    expect(outcome).toMatchObject({ kind: 'retry' })
    expect(outcome.kind !== 'delivered' && outcome.error).toContain('socket hang up')
  })

  it('refuses a base the destination guard refuses, instead of retrying it for an hour', async () => {
    const refused = new DestinationError('the destination is refused: the URL must be https')
    const d = deps(new Error('unused'), { extra: { resolve: () => Promise.reject(refused) } })
    const outcome = await sendTelegram(d.deps, delivery())
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind !== 'delivered' && outcome.error).toContain('must be https')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('retries a resolver that could not answer', async () => {
    const unresolved = new DestinationError('the destination could not be resolved: EAI_AGAIN', true)
    const d = deps(new Error('unused'), { extra: { resolve: () => Promise.reject(unresolved) } })
    expect((await sendTelegram(d.deps, delivery())).kind).toBe('retry')
  })
})
