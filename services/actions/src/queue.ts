import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { DeliveryRef } from './records.js'

export type DeliveryQueue = { send(ref: DeliveryRef, delaySeconds: number): Promise<void> }

// SQS takes at most 900 seconds of delay; every backoff step is inside that, and the reaper covers anything longer
export const MAX_DELAY_SECONDS = 900

export function sqsDeliveryQueue(client: Pick<SQSClient, 'send'>, queueUrl: string): DeliveryQueue {
  return {
    async send(ref, delaySeconds) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          // only a pointer: the item is the truth, and a message that sat in the queue holds nothing stale
          MessageBody: JSON.stringify(ref),
          DelaySeconds: Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.round(delaySeconds))),
        }),
      )
    },
  }
}
