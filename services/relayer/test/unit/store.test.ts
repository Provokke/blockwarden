import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb'
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, it } from 'vitest'
import { MAX_DATA_BYTES } from '../../src/policy.js'
import { RelayerStore, StoreBusyError, TxConflictError } from '../../src/store.js'
import { queuedTx } from '../helpers/fixtures.js'

const FROM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const NOW = Date.parse('2026-09-17T12:00:00.000Z')
const SPEND = { day: '2026-09-17', costGwei: 1, capGwei: 1_000 }

// the shapes real DynamoDB throws when two transactions touch the same item; DynamoDB Local does not produce them
const cancelled = (...codes: string[]) =>
  new TransactionCanceledException({
    $metadata: {},
    message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
const conflict = () =>
  new TransactionConflictException({ $metadata: {}, message: 'Transaction is ongoing for the item' })

// answers reads with an empty item and each write with the next scripted outcome
function fakeStore(writes: (Error | undefined)[]) {
  let sent = 0
  const doc = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) return {}
      // a store that retries forever would otherwise hang the run
      if (++sent > 1_000) throw new Error('runaway retry loop')
      const outcome = writes.length > 1 ? writes.shift() : writes[0]
      if (outcome) throw outcome
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  return { store: new RelayerStore(doc, 'table'), writes: () => sent }
}

describe('RelayerStore against DynamoDB transaction conflicts', () => {
  it('retries a creation cancelled only by a transaction conflict', async () => {
    const { store, writes } = fakeStore([cancelled('None', 'TransactionConflict', 'None'), conflict(), undefined])
    expect(await store.createTx(queuedTx(FROM), SPEND, NOW)).toEqual({ created: true })
    expect(writes()).toBe(3)
  })

  it('gives up on a creation that keeps conflicting, with a recognisable busy error', async () => {
    const { store, writes } = fakeStore([cancelled('TransactionConflict', 'None', 'None')])
    await expect(store.createTx(queuedTx(FROM), SPEND, NOW)).rejects.toThrow(/conflict/)
    await expect(store.createTx(queuedTx(FROM), SPEND, NOW)).rejects.toBeInstanceOf(StoreBusyError)
    expect(writes()).toBe(8)
  })

  it('does not retry a creation whose condition failed alongside a conflict', async () => {
    const { store, writes } = fakeStore([cancelled('None', 'ConditionalCheckFailed', 'TransactionConflict')])
    expect(await store.createTx(queuedTx(FROM), SPEND, NOW)).toEqual({ created: false, reason: 'duplicate' })
    expect(writes()).toBe(1)
  })

  it('retries a nonce assignment cancelled by a transaction conflict', async () => {
    const { store, writes } = fakeStore([cancelled('None', 'TransactionConflict'), undefined])
    expect((await store.assignNonce(queuedTx(FROM), 'x')).nonce).toBe(0)
    expect(writes()).toBe(2)
  })

  it('gives up on a nonce assignment that keeps conflicting, with a recognisable busy error', async () => {
    const { store, writes } = fakeStore([cancelled('TransactionConflict', 'None')])
    await expect(store.assignNonce(queuedTx(FROM), 'x')).rejects.toThrow(/conflict/)
    await expect(store.assignNonce(queuedTx(FROM), 'x')).rejects.toBeInstanceOf(StoreBusyError)
    expect(writes()).toBe(8)
  })

  it('stops chasing a nonce counter that never stops moving', async () => {
    const { store, writes } = fakeStore([cancelled('ConditionalCheckFailed', 'None')])
    await expect(store.assignNonce(queuedTx(FROM), 'x')).rejects.toThrow(/nonce/)
    expect(writes()).toBeLessThanOrEqual(50)
  })

  it('reports a save that collides with an ongoing transaction as a conflict', async () => {
    const { store } = fakeStore([conflict()])
    await expect(store.saveTx(queuedTx(FROM), 'x')).rejects.toBeInstanceOf(TxConflictError)
  })

  it('reports a failure and filler cancelled by a transaction conflict as a conflict', async () => {
    const { store } = fakeStore([cancelled('TransactionConflict', 'None')])
    const filler = queuedTx(FROM, { kind: 'filler', nonce: 4 })
    await expect(store.failWithFiller(queuedTx(FROM, { nonce: 4 }), filler, 'x')).rejects.toBeInstanceOf(
      TxConflictError,
    )
  })
})

describe('RelayerStore.createTx', () => {
  it('refuses calldata over the policy size limit without writing', async () => {
    const { store, writes } = fakeStore([undefined])
    const big = queuedTx(FROM, { data: `0x${'00'.repeat(MAX_DATA_BYTES + 1)}` })
    await expect(store.createTx(big, SPEND, NOW)).rejects.toThrow(`${MAX_DATA_BYTES}`)
    expect(writes()).toBe(0)
    const limit = queuedTx(FROM, { data: `0x${'00'.repeat(MAX_DATA_BYTES)}` })
    expect(await store.createTx(limit, SPEND, NOW)).toEqual({ created: true })
  })
})
