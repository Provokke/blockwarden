import type { SQSRecord } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { processRecords } from '../../src/batch.js'

const record = (messageId: string, group: string, txId: string) =>
  ({ messageId, body: JSON.stringify({ txId }), attributes: { MessageGroupId: group } }) as unknown as SQSRecord

describe('processRecords', () => {
  it('processes every record in order when nothing fails', async () => {
    const seen: string[] = []
    const result = await processRecords(
      [record('m1', 'a', 't1'), record('m2', 'b', 't2'), record('m3', 'a', 't3')],
      async (txId) => seen.push(txId),
      () => {},
    )
    expect(seen).toEqual(['t1', 't2', 't3'])
    expect(result).toEqual({ batchItemFailures: [] })
  })

  it('hands back a failed message and every later message of its group, but not other groups', async () => {
    const seen: string[] = []
    const logs: string[] = []
    const result = await processRecords(
      [record('m1', 'a', 't1'), record('m2', 'b', 't2'), record('m3', 'a', 't3'), record('m4', 'b', 't4')],
      async (txId) => {
        seen.push(txId)
        if (txId === 't1') throw new Error('KMS throttled')
      },
      (message) => logs.push(message),
    )
    expect(seen).toEqual(['t1', 't2', 't4'])
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }, { itemIdentifier: 'm3' }])
    expect(logs).toEqual(['message failed; SQS will deliver it again'])
  })

  it('hands back a message whose body is not a transaction message', async () => {
    const bad = { messageId: 'm1', body: 'not json', attributes: { MessageGroupId: 'a' } } as unknown as SQSRecord
    const result = await processRecords(
      [bad],
      async () => {},
      () => {},
    )
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
  })
})
