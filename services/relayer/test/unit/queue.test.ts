import type { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { describe, expect, it } from 'vitest'
import { sqsTxQueue } from '../../src/queue.js'
import { queuedTx } from '../helpers/fixtures.js'

const FROM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

// a fake SQS client that only records what it was asked to send
function fakeSqs() {
  const sent: SendMessageCommand['input'][] = []
  const client = {
    send: async (command: SendMessageCommand) => {
      sent.push(command.input)
      return {}
    },
  } as unknown as Pick<SQSClient, 'send'>
  return { client, sent }
}

describe('sqsTxQueue', () => {
  it('sends the deduplication id keyed to the enqueue count and the group id keyed to the signer', async () => {
    const { client, sent } = fakeSqs()
    const queue = sqsTxQueue(client, 'https://sqs.example/relayer.fifo')
    const tx = queuedTx(FROM, { txId: 'tx-9', signerId: 'billing', enqueues: 3 })
    await queue.send(tx)
    expect(sent).toEqual([
      expect.objectContaining({
        QueueUrl: 'https://sqs.example/relayer.fifo',
        MessageBody: JSON.stringify({ txId: 'tx-9' }),
        MessageGroupId: 'billing',
        MessageDeduplicationId: 'tx-9-3',
      }),
    ])
  })
})
