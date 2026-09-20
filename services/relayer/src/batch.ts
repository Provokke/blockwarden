import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { describeError } from './chain.js'
import type { TxMessage } from './queue.js'

// the signer's Lambda timeout, set in modules/relayer/functions.tf
export const SIGNER_TIMEOUT_MS = 60_000

// The RPC calls one message makes at worst, each of which waits out every hung URL in turn: the dependsOn estimate,
// the cold nonce read, three for the fee estimate (block, tip, and the gas price viem falls back to on a node with no
// eth_maxPriorityFeePerGas), the send, and the receipt check a "nonce too low" answer costs. The refusal path's
// filler estimate lands on the same total. A nonce reset repeats a pass, which is why processTx checks the margin
// again before one.
export const SIGNER_CALLS_PER_MESSAGE = 7

// the DynamoDB reads and writes and the one KMS Sign around those calls
const SIGNER_AWS_MS = 4_000

// What is left of the timeout splits in two: one message's RPC calls, and the margin, which has to hold a whole
// message because a message may start with only the margin left. chainOptionsFor divides this by the calls and URLs.
export const SIGNER_RPC_BUDGET_MS = (SIGNER_TIMEOUT_MS - SIGNER_AWS_MS) / 2

// stop taking messages once less than one worst-case message's time remains
export const DEADLINE_MARGIN_MS = SIGNER_RPC_BUDGET_MS + SIGNER_AWS_MS

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
