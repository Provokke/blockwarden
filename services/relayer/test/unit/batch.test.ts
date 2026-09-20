import type { SQSRecord } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { DEADLINE_MARGIN_MS, processRecords } from '../../src/batch.js'

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
      (message, _data, level) => logs.push(`${level}: ${message}`),
    )
    expect(seen).toEqual(['t1', 't2', 't4'])
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }, { itemIdentifier: 'm3' }])
    expect(logs).toEqual(['error: message failed; SQS will deliver it again'])
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

  it('stops before starting a record once too little time remains, and hands back every later record too', async () => {
    const seen: string[] = []
    const logs: string[] = []
    const remaining = [DEADLINE_MARGIN_MS + 1, DEADLINE_MARGIN_MS - 1, DEADLINE_MARGIN_MS - 1]
    let call = 0
    const result = await processRecords(
      [record('m1', 'a', 't1'), record('m2', 'b', 't2'), record('m3', 'c', 't3')],
      async (txId) => seen.push(txId),
      (message) => logs.push(message),
      () => remaining[call++]!,
    )
    expect(seen).toEqual(['t1'])
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }])
    expect(logs).toEqual([
      'message not processed; too little time remains before the Lambda timeout',
      'message not processed; too little time remains before the Lambda timeout',
    ])
  })

  it('processes every record when remainingMs is not given', async () => {
    const seen: string[] = []
    const result = await processRecords(
      [record('m1', 'a', 't1'), record('m2', 'b', 't2')],
      async (txId) => seen.push(txId),
      () => {},
    )
    expect(seen).toEqual(['t1', 't2'])
    expect(result).toEqual({ batchItemFailures: [] })
  })

  it.each(['{}', '{"txId":1}', '{"txId":""}', 'null'])(
    'hands back and logs a message whose body is %s',
    async (body) => {
      const seen: string[] = []
      const logs: string[] = []
      const bad = { messageId: 'm1', body, attributes: { MessageGroupId: 'a' } } as unknown as SQSRecord
      const result = await processRecords(
        [bad, record('m2', 'b', 't2')],
        async (txId) => seen.push(txId),
        (message) => logs.push(message),
      )
      expect(seen).toEqual(['t2'])
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
      expect(logs).toEqual(['message failed; SQS will deliver it again'])
    },
  )
})
