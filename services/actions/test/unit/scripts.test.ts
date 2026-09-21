import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { describe, expect, it, vi } from 'vitest'
import {
  allDead,
  checkRedriveArgs,
  describeTarget,
  drainRedriven,
  positiveInt,
  redactedUrl,
} from '../../scripts/lib.js'
import type { DeliveryRecord, DeliveryRef } from '../../src/records.js'
import type { DeadPage } from '../../src/store.js'

// the path shape of a Slack incoming webhook, on a host that is not Slack's: a fixture carrying the real
// host matches secret scanning on every push, and nothing here reads the host
const SLACK_SHAPED = 'https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-secret'

describe('redactedUrl', () => {
  it('keeps the origin and drops the part of the path that is the credential', () => {
    for (const raw of [SLACK_SHAPED, DISCORD]) {
      const shown = redactedUrl(raw)
      expect(shown, raw).toContain(new URL(raw).origin)
      // whatever it prints must not be a URL anyone could send to
      expect(shown, raw).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX')
      expect(shown, raw).not.toContain('secret')
      expect(shown.length, raw).toBeLessThan(raw.length)
    }
  })

  it('drops the query string, which is where a signed URL carries its token', () => {
    expect(redactedUrl('https://example.com/hook?token=letmein')).not.toContain('letmein')
  })

  it('says so rather than throwing when the stored URL does not parse', () => {
    expect(redactedUrl('not a url')).toBe('(unreadable url)')
  })
})

describe('describeTarget', () => {
  it('redacts a webhook URL and names the channel for everything else', () => {
    expect(describeTarget({ channel: 'webhook', target: { channel: 'webhook', url: SLACK_SHAPED } })).toBe(
      redactedUrl(SLACK_SHAPED),
    )
    expect(describeTarget({ channel: 'telegram', target: { channel: 'telegram', chatId: '1' } })).toBe('telegram')
  })
})

describe('positiveInt', () => {
  it('takes a whole number and refuses anything else', () => {
    expect(positiveInt('25')).toBe(25)
    for (const raw of ['abc', '0', '-1', '2.5', '', ' ', undefined]) {
      expect(positiveInt(raw), String(raw)).toBeUndefined()
    }
  })
})

describe('checkRedriveArgs', () => {
  it('refuses --id and --all together rather than letting --all win', () => {
    expect(checkRedriveArgs({ table: 't', queue: 'q', id: 'dlv_nope', all: true })).toContain('not both')
  })

  it('refuses neither of them, and takes either one alone', () => {
    expect(checkRedriveArgs({ table: 't', queue: 'q' })).toContain('--id')
    expect(checkRedriveArgs({ table: 't', queue: 'q', id: 'dlv_1' })).toBeUndefined()
    expect(checkRedriveArgs({ table: 't', queue: 'q', all: true })).toBeUndefined()
  })

  it('still wants a table and a queue', () => {
    expect(checkRedriveArgs({ queue: 'q', all: true })).toContain('--table')
    expect(checkRedriveArgs({ table: 't', all: true })).toContain('--queue')
  })
})

const dead = (deliveryId: string) => ({ deliveryId }) as DeliveryRecord

describe('allDead', () => {
  it('walks the cursor, so a long dead list is neither cut short nor a false negative', async () => {
    const pages: DeadPage[] = [
      { deliveries: [dead('dlv_1')], cursor: { PK: 'a' } },
      { deliveries: [dead('dlv_2')], cursor: { PK: 'b' } },
      { deliveries: [dead('dlv_3')] },
    ]
    const listDeadPage = vi.fn(async () => pages.shift()!)
    expect((await allDead({ listDeadPage }, 1)).map((d) => d.deliveryId)).toEqual(['dlv_1', 'dlv_2', 'dlv_3'])
    expect(listDeadPage).toHaveBeenCalledTimes(3)
    expect(listDeadPage).toHaveBeenNthCalledWith(1, 1, undefined)
    expect(listDeadPage).toHaveBeenNthCalledWith(2, 1, { PK: 'a' })
    expect(listDeadPage).toHaveBeenNthCalledWith(3, 1, { PK: 'b' })
  })

  it('stops at the first page when there is no cursor', async () => {
    const listDeadPage = vi.fn(async () => ({ deliveries: [] }))
    expect(await allDead({ listDeadPage })).toEqual([])
    expect(listDeadPage).toHaveBeenCalledOnce()
  })
})

const ref = (sk: string): DeliveryRef => ({ subject: 'MATCH#1', sk })

// a fake SQS that answers one receive per queued batch and then nothing, which is what the real queue does once
// everything visible is in flight
function fakeSqs(batches: { Body: string; ReceiptHandle: string }[][]) {
  const deleted: string[] = []
  const receives: unknown[] = []
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DeleteMessageCommand) {
      deleted.push(command.input.ReceiptHandle!)
      return {}
    }
    if (command instanceof ReceiveMessageCommand) {
      receives.push(command.input)
      const next = batches.shift()
      return next ? { Messages: next } : {}
    }
    throw new Error('unexpected command')
  })
  return { sqs: { send } as never, deleted, receives, send }
}

describe('drainRedriven', () => {
  it('deletes the dead-letter copy of a delivery it redrove and leaves everything else alone', async () => {
    const mine = ref('DELIVERY#mine')
    const theirs = ref('DELIVERY#theirs')
    const { sqs, deleted } = fakeSqs([
      [
        { Body: JSON.stringify(theirs), ReceiptHandle: 'rh-theirs' },
        { Body: JSON.stringify(mine), ReceiptHandle: 'rh-mine' },
      ],
    ])
    expect(await drainRedriven(sqs, 'https://sqs/dlq', [mine])).toBe(1)
    expect(deleted).toEqual(['rh-mine'])
  })

  it('stops at the first empty receive rather than waiting for a queue that is never empty', async () => {
    const mine = ref('DELIVERY#mine')
    const { sqs, receives } = fakeSqs([[{ Body: '{"not":"a ref"}', ReceiptHandle: 'rh-other' }]])
    expect(await drainRedriven(sqs, 'https://sqs/dlq', [mine])).toBe(0)
    expect(receives).toHaveLength(2)
  })

  // the pipeline makes several copies of one delivery on purpose: the sender copies it again every time an
  // already-dead delivery comes round, and the reaper copies before markDead. Deleting one leaves the alarm on.
  it('deletes every copy of a redriven delivery, not just the first', async () => {
    const mine = ref('DELIVERY#mine')
    const { sqs, deleted } = fakeSqs([
      [
        { Body: JSON.stringify(mine), ReceiptHandle: 'rh-1' },
        { Body: JSON.stringify(mine), ReceiptHandle: 'rh-2' },
      ],
      [{ Body: JSON.stringify(mine), ReceiptHandle: 'rh-3' }],
    ])
    expect(await drainRedriven(sqs, 'https://sqs/dlq', [mine])).toBe(3)
    expect(deleted).toEqual(['rh-1', 'rh-2', 'rh-3'])
  })

  it('does not receive at all when nothing was redriven', async () => {
    const { sqs, send } = fakeSqs([])
    expect(await drainRedriven(sqs, 'https://sqs/dlq', [])).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
