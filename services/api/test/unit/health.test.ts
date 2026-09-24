import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { describe, expect, it } from 'vitest'
import { handleHealth, type HealthDeps } from '../../src/health.js'

const TABLE = 'blockwarden'
const NOW = Date.parse('2026-09-24T12:00:00.000Z')
const DELIVERY = 'https://sqs.eu-west-2.amazonaws.com/123456789012/deliveries'
const OTHER = 'https://sqs.eu-west-2.amazonaws.com/123456789012/other'

// the cursor row exactly as services/monitor/src/store.ts's saveCursor writes it
function cursorRow(chainId: number, durableBlock: number | bigint, fastBlock: number | bigint, updatedAt?: string) {
  return {
    PK: `CHAIN#${chainId}`,
    SK: 'CURSOR',
    durableBlock,
    fastBlock,
    version: 7,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

// answers a GetItem only for the table and the exact key it was asked for: a fake that handed every chain the same
// row would pass the per-chain tests without the handler ever building a per-chain key
function fakeDoc(rows: Record<string, unknown>[], failing: number[] = []): HealthDeps['doc'] {
  return {
    async send(command) {
      if (!(command instanceof GetCommand)) throw new Error('health only reads single items')
      const { TableName, Key } = command.input
      if (TableName !== TABLE) return {}
      const chainId = Number(String(Key?.PK).replace('CHAIN#', ''))
      if (failing.includes(chainId)) throw new Error('ProvisionedThroughputExceededException')
      const item = rows.find((row) => row.PK === Key?.PK && row.SK === Key?.SK)
      return item ? { Item: item } : {}
    },
  }
}

// answers only the queue URL it was asked about, and only the attributes it was asked for, as SQS does
function fakeSqs(depths: Record<string, { visible: number; inFlight: number } | 'fail'>): HealthDeps['sqs'] {
  return {
    async send(command) {
      if (!(command instanceof GetQueueAttributesCommand)) throw new Error('health only reads queue attributes')
      const depth = depths[command.input.QueueUrl ?? '']
      if (depth === undefined) throw new Error('AWS.SimpleQueueService.NonExistentQueue')
      if (depth === 'fail') throw new Error('AccessDenied')
      const all: Record<string, string> = {
        ApproximateNumberOfMessages: String(depth.visible),
        ApproximateNumberOfMessagesNotVisible: String(depth.inFlight),
        ApproximateNumberOfMessagesDelayed: '99',
      }
      const asked = command.input.AttributeNames ?? []
      return { Attributes: Object.fromEntries(Object.entries(all).filter(([name]) => asked.includes(name as never))) }
    },
  }
}

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps & { logged: unknown[][] } {
  const logged: unknown[][] = []
  return {
    doc: fakeDoc([]),
    sqs: fakeSqs({ [DELIVERY]: { visible: 0, inFlight: 0 } }),
    table: TABLE,
    chainIds: [8453, 42161],
    queues: { delivery: DELIVERY },
    now: () => NOW,
    log: (...args) => logged.push(args),
    logged,
    ...overrides,
  }
}

describe('handleHealth', () => {
  it('reports each chain from its own cursor row, with the age of the last write', async () => {
    const result = await handleHealth(
      deps({
        doc: fakeDoc([
          cursorRow(8453, 100, 110, new Date(NOW - 90_000).toISOString()),
          cursorRow(42161, 2_000, 2_050, new Date(NOW - 5_500).toISOString()),
        ]),
      }),
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      chains: {
        8453: { durableBlock: '100', fastBlock: '110', cursorAgeSeconds: 90 },
        42161: { durableBlock: '2000', fastBlock: '2050', cursorAgeSeconds: 5 },
      },
    })
  })

  it('reports a chain with no cursor row yet as nulls, never as block zero', async () => {
    const result = await handleHealth(
      deps({ doc: fakeDoc([cursorRow(42161, 2_000, 2_050, new Date(NOW - 1_000).toISOString())]) }),
    )
    const chains = (result.body as { chains: Record<string, unknown> }).chains
    expect(chains['8453']).toEqual({ durableBlock: null, fastBlock: null, cursorAgeSeconds: null })
    expect(chains['42161']).toEqual({ durableBlock: '2000', fastBlock: '2050', cursorAgeSeconds: 1 })
  })

  it('carries a block number past 2^53 exactly, as the document client hands it back', async () => {
    const big = 2n ** 53n + 3n
    const result = await handleHealth(
      deps({ chainIds: [8453], doc: fakeDoc([cursorRow(8453, big, big + 1n, new Date(NOW).toISOString())]) }),
    )
    expect((result.body as { chains: Record<string, { durableBlock: string }> }).chains['8453']).toEqual({
      durableBlock: '9007199254740995',
      fastBlock: '9007199254740996',
      cursorAgeSeconds: 0,
    })
  })

  it('reports blocks but no age for a row with no readable write time', async () => {
    const result = await handleHealth(
      deps({ chainIds: [8453, 42161], doc: fakeDoc([cursorRow(8453, 5, 6), cursorRow(42161, 7, 8, 'not a date')]) }),
    )
    expect((result.body as { chains: unknown }).chains).toEqual({
      8453: { durableBlock: '5', fastBlock: '6', cursorAgeSeconds: null },
      42161: { durableBlock: '7', fastBlock: '8', cursorAgeSeconds: null },
    })
  })

  it('reports each queue from its own attributes', async () => {
    const result = await handleHealth(
      deps({
        queues: { delivery: DELIVERY, other: OTHER },
        sqs: fakeSqs({ [DELIVERY]: { visible: 3, inFlight: 1 }, [OTHER]: { visible: 40, inFlight: 2 } }),
      }),
    )
    expect((result.body as { queues: unknown }).queues).toEqual({
      delivery: { visible: 3, inFlight: 1 },
      other: { visible: 40, inFlight: 2 },
    })
  })

  it('reports a queue it could not read as null and still answers 200 for the rest', async () => {
    const result = await handleHealth(
      deps({
        queues: { delivery: DELIVERY, other: OTHER },
        sqs: fakeSqs({ [DELIVERY]: 'fail', [OTHER]: { visible: 4, inFlight: 0 } }),
        doc: fakeDoc([cursorRow(8453, 1, 2, new Date(NOW).toISOString())]),
      }),
    )
    expect(result.status).toBe(200)
    const body = result.body as { chains: Record<string, unknown>; queues: Record<string, unknown> }
    expect(body.queues).toEqual({ delivery: null, other: { visible: 4, inFlight: 0 } })
    expect(body.chains['8453']).toEqual({ durableBlock: '1', fastBlock: '2', cursorAgeSeconds: 0 })
  })

  it('reports a chain it could not read as null and still answers 200 for the rest', async () => {
    const d = deps({
      doc: fakeDoc([cursorRow(8453, 1, 2, new Date(NOW).toISOString())], [42161]),
      sqs: fakeSqs({ [DELIVERY]: { visible: 2, inFlight: 0 } }),
    })
    const result = await handleHealth(d)
    expect(result.status).toBe(200)
    const body = result.body as { chains: Record<string, unknown>; queues: Record<string, unknown> }
    expect(body.chains).toEqual({ 8453: { durableBlock: '1', fastBlock: '2', cursorAgeSeconds: 0 }, 42161: null })
    expect(body.queues).toEqual({ delivery: { visible: 2, inFlight: 0 } })
    expect(
      d.logged.some(([, data, level]) => level === 'warn' && (data as { chainId?: number }).chainId === 42161),
    ).toBe(true)
  })
})
