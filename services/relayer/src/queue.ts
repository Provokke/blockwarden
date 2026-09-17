import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { TxRecord } from './records.js'

export interface TxQueue {
  send(tx: TxRecord): Promise<void>
}

export type TxMessage = { txId: string }

export function sqsTxQueue(client: Pick<SQSClient, 'send'>, queueUrl: string): TxQueue {
  return {
    async send(tx) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ txId: tx.txId } satisfies TxMessage),
          // one group per signer, so a signer's transactions are signed one at a time and in order
          MessageGroupId: tx.signerId,
          // Not the caller's idempotency key: two API keys may pick the same one. The enqueue count lets the sweeper
          // requeue a transaction inside SQS's five-minute deduplication window.
          MessageDeduplicationId: `${tx.txId}-${tx.enqueues}`,
        }),
      )
    },
  }
}
