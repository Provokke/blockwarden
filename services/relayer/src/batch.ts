import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { describeError } from './chain.js'
import type { TxMessage } from './queue.js'

// FIFO order holds only if nothing after a failed message in its group runs ahead of it, so once one message
// fails, every later message in that group is handed back too
export async function processRecords(
  records: SQSRecord[],
  processTx: (txId: string) => Promise<unknown>,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
): Promise<SQSBatchResponse> {
  const failedGroups = new Set<string>()
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = []
  for (const record of records) {
    const group = record.attributes.MessageGroupId ?? ''
    if (failedGroups.has(group)) {
      batchItemFailures.push({ itemIdentifier: record.messageId })
      continue
    }
    try {
      const { txId } = JSON.parse(record.body) as TxMessage
      // processTx reads a missing txId as a deleted transaction and the message would vanish; the DLQ keeps it
      if (typeof txId !== 'string' || txId === '') throw new Error('message body has no txId')
      await processTx(txId)
    } catch (err) {
      log(
        'message failed; SQS will deliver it again',
        { messageId: record.messageId, error: describeError(err) },
        'error',
      )
      failedGroups.add(group)
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures }
}
