import http from 'node:http'
import { once } from 'node:events'
import { verifyWebhook } from '@blockwarden/relayer-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendWebhook } from '../../src/senders/webhook.js'
import type { DeliveryRecord } from '../../src/records.js'

let server: http.Server
let port: number
let received: { body: string; headers: http.IncomingHttpHeaders } | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received = { body, headers: req.headers }
      res.writeHead(204)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as { port: number }).port
})

afterAll(() => server.close())

const delivery = (url: string): DeliveryRecord => ({
  deliveryId: 'dlv_real',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'webhook',
  target: { channel: 'webhook', url, secretParameter: '/bw/secret' },
  payload: JSON.stringify({ id: 'dlv_real', type: 'match.final', createdAt: 'now', specVersion: 1, data: {} }),
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

const deps = { secrets: { read: async () => ['s1', 's2'] }, now: () => Date.now(), log: () => {} }

describe('the real sender', () => {
  it('refuses a loopback URL through the guard it uses in production', async () => {
    const outcome = await sendWebhook(deps, delivery(`https://127.0.0.1:${port}/hook`))
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('127.0.0.0/8')
    expect(received).toBeUndefined()
  })

  it('signs a real request so verifyWebhook accepts it under either secret', async () => {
    // the guard refuses loopback, so the destination is supplied the way the guard would have supplied it
    const target = {
      url: new URL(`http://127.0.0.1:${port}/hook`),
      host: '127.0.0.1',
      address: '127.0.0.1',
      family: 4 as const,
      port,
    }
    const outcome = await sendWebhook(
      { ...deps, resolve: async () => target } as never,
      delivery(`https://example.com/hook`),
    )
    expect(outcome).toMatchObject({ kind: 'delivered', statusCode: 204 })
    const signature = received!.headers['x-blockwarden-signature'] as string
    for (const secret of ['s1', 's2']) {
      await expect(verifyWebhook({ payload: received!.body, signature, secret })).resolves.toMatchObject({
        id: 'dlv_real',
      })
    }
    expect(received!.headers['x-blockwarden-delivery']).toBe('dlv_real')
  })
})
