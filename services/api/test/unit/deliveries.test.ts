import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { encodeCursor } from '../../src/http.js'
import { handleListDeliveries, handleRedrive, type DeliveryDeps } from '../../src/deliveries.js'
import type { DeliveryItem } from '../../src/store.js'

// narrowed to the real event type rather than to `never`, same helper as matches.test.ts and rules.test.ts
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

function dead(id: string): DeliveryItem {
  return {
    deliveryId: id,
    subject: `MATCH#0x${id}`,
    sk: `DELIVERY#a1#match.final#0`,
    channel: 'webhook',
    target: 'https://hooks.example.com/services/T0/B0/secretpart',
    status: 'dead',
    attempts: 8,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:43:00.000Z',
    lastError: 'the destination answered 500',
    lastStatusCode: 500,
    version: 9,
  }
}

// a page key shaped like the one the real store actually returns (GSI1's own LastEvaluatedKey: PK, SK,
// GSI1PK, GSI1SK - see deliveries.ts's DEAD_LIST_KEY_ATTRS), so this fake exercises the same cursor
// shape-check the real store's key would have to pass (matches.test.ts's pageKey does the same for matches)
function pageKey(row: DeliveryItem): Record<string, string> {
  return { PK: row.subject, SK: row.sk, GSI1PK: 'DELIVERY#DEAD', GSI1SK: row.deliveryId }
}

function deps() {
  const rows = [dead('one'), dead('two'), dead('three')]
  const sent: unknown[] = []
  const requeued: string[] = []
  const d: DeliveryDeps & { sent: unknown[]; requeued: string[] } = {
    sent,
    requeued,
    queueUrl: 'https://sqs.local/deliveries',
    now: () => 1_770_000_000_000,
    store: {
      async listDead(limit, cursor) {
        const from = cursor ? rows.findIndex((r) => r.deliveryId === cursor.GSI1SK) + 1 : 0
        const page = rows.slice(from, from + limit)
        const last = page[page.length - 1]
        const next = from + limit < rows.length && last ? pageKey(last) : undefined
        return { deliveries: page, ...(next ? { cursor: next } : {}) }
      },
      async listBySubject(subject, limit) {
        return { deliveries: rows.filter((r) => r.subject === subject).slice(0, limit) }
      },
      async getDelivery(ref) {
        return rows.find((r) => r.subject === ref.subject && r.sk === ref.sk)
      },
      async requeueDelivery(delivery, nowMs) {
        void nowMs
        const row = rows.find((r) => r.subject === delivery.subject && r.sk === delivery.sk)
        if (!row || row.status !== 'dead') return false
        row.status = 'pending'
        requeued.push(row.deliveryId)
        return true
      },
    },
    queue: {
      async send(body) {
        sent.push(body)
      },
    },
  }
  return d
}

function event(query: Record<string, string> = {}) {
  return apiEvent({ routeKey: 'GET /v1/deliveries', queryStringParameters: query })
}

function redriveEvent(deliveryId: string, body?: unknown) {
  return apiEvent({
    routeKey: 'POST /v1/deliveries/{deliveryId}/redrive',
    pathParameters: { deliveryId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('handleListDeliveries', () => {
  it('lists the dead letters', async () => {
    const result = await handleListDeliveries(deps(), event({ status: 'dead' }))
    expect(result.status).toBe(200)
    expect((result.body as { deliveries: unknown[] }).deliveries).toHaveLength(3)
  })

  it('redacts the credential part of a webhook target', async () => {
    const result = await handleListDeliveries(deps(), event({ status: 'dead' }))
    const [first] = (result.body as { deliveries: { target: string }[] }).deliveries
    expect(first!.target).not.toContain('secretpart')
    expect(first!.target).toContain('hooks.example.com')
  })

  it('refuses a status with no index behind it, instead of scanning', async () => {
    for (const status of ['pending', 'delivered', 'sending']) {
      const result = await handleListDeliveries(deps(), event({ status }))
      expect(result.status, status).toBe(400)
      expect((result.body as { error: { code: string } }).error.code).toBe('unsupported_status')
    }
  })

  it('requires either a status or a subject', async () => {
    const result = await handleListDeliveries(deps(), event({}))
    expect(result.status).toBe(400)
  })

  it('lists one subject partition when asked', async () => {
    const result = await handleListDeliveries(deps(), event({ subject: 'MATCH#0xone' }))
    expect((result.body as { deliveries: unknown[] }).deliveries).toHaveLength(1)
  })

  it('refuses a subject that is not one of the three kinds', async () => {
    const result = await handleListDeliveries(deps(), event({ subject: 'RULE#r1' }))
    expect(result.status).toBe(400)
  })

  it('hands back a ref per row that addresses the delivery', async () => {
    const result = await handleListDeliveries(deps(), event({ status: 'dead' }))
    const [first] = (result.body as { deliveries: { ref: string }[] }).deliveries
    expect(typeof first!.ref).toBe('string')
    expect(first!.ref.length).toBeGreaterThan(0)
  })

  it('pages with a cursor', async () => {
    const d = deps()
    const first = await handleListDeliveries(d, event({ status: 'dead', limit: '2' }))
    const body = first.body as { deliveries: unknown[]; cursor?: string }
    expect(body.deliveries).toHaveLength(2)
    const second = await handleListDeliveries(d, event({ status: 'dead', limit: '2', cursor: body.cursor! }))
    expect((second.body as { deliveries: unknown[] }).deliveries).toHaveLength(1)
  })

  it('refuses a cursor that is not shaped like a real page key, instead of forwarding it to DynamoDB', async () => {
    const d = deps()
    for (const key of [{ after: 2 }, { PK: 'x', SK: 'y' }, { PK: 'x', SK: 'y', GSI1PK: 'z', GSI1SK: 1 }]) {
      const cursor = encodeCursor(key)
      const result = await handleListDeliveries(d, event({ status: 'dead', cursor }))
      expect((result.body as { error: { code: string } }).error.code, JSON.stringify(key)).toBe('invalid_cursor')
    }
  })
})

describe('handleRedrive', () => {
  it('puts a dead delivery back on the queue', async () => {
    const d = deps()
    const list = await handleListDeliveries(d, event({ status: 'dead' }))
    const [row] = (list.body as { deliveries: { deliveryId: string; ref: string }[] }).deliveries
    const result = await handleRedrive(d, redriveEvent(row!.deliveryId, { ref: row!.ref }))
    expect(result.status).toBe(200)
    expect(d.requeued).toEqual([row!.deliveryId])
    expect(d.sent).toHaveLength(1)
  })

  it('resets the row before it enqueues, so a failed send leaves nothing claiming to be pending twice', async () => {
    const d = deps()
    const list = await handleListDeliveries(d, event({ status: 'dead' }))
    const [row] = (list.body as { deliveries: { deliveryId: string; ref: string }[] }).deliveries
    d.queue.send = async () => {
      throw new Error('sqs is down')
    }
    await expect(handleRedrive(d, redriveEvent(row!.deliveryId, { ref: row!.ref }))).rejects.toThrow()
    // the reaper owns a pending delivery with a due time, so a lost enqueue is swept rather than lost
    expect(d.requeued).toHaveLength(1)
  })

  it('refuses a ref whose delivery id does not match the path, so one row cannot be redriven under another id', async () => {
    const d = deps()
    const list = await handleListDeliveries(d, event({ status: 'dead' }))
    const rows = (list.body as { deliveries: { deliveryId: string; ref: string }[] }).deliveries
    const result = await handleRedrive(d, redriveEvent(rows[0]!.deliveryId, { ref: rows[1]!.ref }))
    expect(result.status).toBe(400)
    expect(d.requeued).toHaveLength(0)
  })

  it('reports a delivery that is not dead as a conflict, not as done', async () => {
    const d = deps()
    const list = await handleListDeliveries(d, event({ status: 'dead' }))
    const [row] = (list.body as { deliveries: { deliveryId: string; ref: string }[] }).deliveries
    await handleRedrive(d, redriveEvent(row!.deliveryId, { ref: row!.ref }))
    const again = await handleRedrive(d, redriveEvent(row!.deliveryId, { ref: row!.ref }))
    expect(again.status).toBe(409)
    expect(d.sent).toHaveLength(1)
  })

  it('reports an unknown delivery as missing', async () => {
    const d = deps()
    const ref = encodeCursor({ subject: 'MATCH#0xnope', sk: 'DELIVERY#a1#match.final#0' })
    const result = await handleRedrive(d, redriveEvent('nope', { ref }))
    expect(result.status).toBe(404)
  })

  it('refuses a ref that is not a ref', async () => {
    const d = deps()
    const result = await handleRedrive(d, redriveEvent('one', { ref: 'garbage' }))
    expect(result.status).toBe(400)
    expect(d.requeued).toHaveLength(0)
  })
})
