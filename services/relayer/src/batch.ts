import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { describeError } from './chain.js'
import type { TxMessage } from './queue.js'

// processTx makes several RPC round trips (nonce, fee estimate, send, and sometimes a receipt or estimate on top);
// each one can take up to chain.ts's 10s http timeout before it errors or fails over. 12s leaves room for one more
// record's worst single RPC leg plus its DynamoDB and KMS calls, while still landing well inside the signer's 30s
// Lambda timeout.
const DEADLINE_MARGIN_MS = 12_000

// FIFO order holds only if nothing after a failed message in its group runs ahead of it, so once one message
// fails, every later message in that group is handed back too
export async function processRecords(
  records: SQSRecord[],
  processTx: (txId: string) => Promise<unknown>,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
  // remaining time on the Lambda invocation; omitted in tests that don't care about the deadline
  remainingMs?: () => number,
): Promise<SQSBatchResponse> {
  const failedGroups = new Set<string>()
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = []
  for (const record of records) {
    const group = record.attributes.MessageGroupId ?? ''
    if (failedGroups.has(group)) {
      batchItemFailures.push({ itemIdentifier: record.messageId })
      continue
    }
    if (remainingMs && remainingMs() < DEADLINE_MARGIN_MS) {
      log('message not processed; too little time remains before the Lambda timeout', { messageId: record.messageId })
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
