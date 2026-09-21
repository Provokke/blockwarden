import http from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sendTelegram } from '../../src/senders/telegram.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { SenderDeps } from '../../src/senders/types.js'

let server: http.Server
let port: number
let received: { url: string; body: string; headers: http.IncomingHttpHeaders } | undefined
let answer = { status: 200, body: '{"ok":true,"result":{"message_id":1}}' }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received = { url: req.url ?? '', body, headers: req.headers }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as { port: number }).port
})

afterAll(() => server.close())

beforeEach(() => {
  received = undefined
  answer = { status: 200, body: '{"ok":true,"result":{"message_id":1}}' }
})

const delivery = (): DeliveryRecord => ({
  deliveryId: 'dlv_tg_real',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'telegram',
  target: { channel: 'telegram', chatId: '-1001234567890' },
  payload: JSON.stringify({
    id: 'dlv_tg_real',
    type: 'match.final',
    createdAt: 'now',
    specVersion: 1,
    data: { eventName: 'Transfer', chainId: 8453, status: 'final', args: { value: '1000000000000000000' } },
  }),
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

// the fake records the parameter it was asked for, so a test proves which name the sender read
const asked: string[] = []
const deps = (extra: Partial<SenderDeps> = {}): SenderDeps => ({
  secrets: {
    read: async (name: string) => {
      asked.push(name)
      return ['123456:token']
    },
  },
  now: () => Date.now(),
  log: () => {},
  telegramTokenParameter: '/bw/telegram',
  ...extra,
})

// the guard refuses loopback, so the API base is supplied the way the guard would have supplied it, and the
// request itself still goes out through the real postJson
const local = () => ({
  url: new URL(`http://127.0.0.1:${port}`),
  host: '127.0.0.1',
  address: '127.0.0.1',
  family: 4 as const,
  port,
})

describe('the real Telegram sender', () => {
  it('posts the message to a real server, with the token only in the path', async () => {
    const outcome = await sendTelegram(deps({ resolve: async () => local() }), delivery())
    expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 })
    expect(received!.url).toBe('/bot123456:token/sendMessage')
    expect(JSON.parse(received!.body)).toMatchObject({ chat_id: '-1001234567890', disable_web_page_preview: true })
    expect(JSON.parse(received!.body).text).toContain('1000000000000000000')
    expect(received!.headers['content-type']).toBe('application/json')
    expect(asked).toContain('/bw/telegram')
  })

  it('retries a 401 from the real path rather than dead-lettering the alert', async () => {
    answer = { status: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized"}' }
    const outcome = await sendTelegram(deps({ resolve: async () => local() }), delivery())
    expect(outcome).toMatchObject({ kind: 'retry', statusCode: 401 })
    expect(JSON.stringify(outcome)).not.toContain('123456:token')
  })

  it('refuses a loopback API base through the guard it uses in production, and sends nothing', async () => {
    const outcome = await sendTelegram(deps({ telegramApiBase: `https://127.0.0.1:${port}` }), delivery())
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('127.0.0.0/8')
    expect(received).toBeUndefined()
  })
})
