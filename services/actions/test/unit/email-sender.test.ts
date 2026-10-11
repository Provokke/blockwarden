import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { describe, expect, it, vi } from 'vitest'
import { sendEmail } from '../../src/senders/email.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { SenderDeps } from '../../src/senders/types.js'

const delivery = (subject?: string): DeliveryRecord => ({
  deliveryId: 'dlv_mail',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'email',
  target: { channel: 'email', to: ['ops@example.com'], ...(subject ? { subject } : {}) },
  payload: JSON.stringify({
    id: 'dlv_mail',
    type: 'match.final',
    createdAt: 'now',
    specVersion: 1,
    data: { eventName: 'Transfer', chainId: 8453, status: 'final', args: {} },
  }),
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

// the fake records the command it was given, so a test can prove what SES was actually asked to send
const fakeSes = (answer: unknown = { MessageId: 'ses-message-1' }) => {
  const sent: SendEmailCommand[] = []
  const send = vi.fn(async (command: SendEmailCommand) => {
    sent.push(command)
    if (answer instanceof Error) throw answer
    return answer
  })
  return { ses: { send } as unknown as SenderDeps['ses'], sent }
}

const deps = (ses: SenderDeps['ses'], extra: Partial<SenderDeps> = {}): SenderDeps => ({
  secrets: { read: async () => ['x'] },
  now: () => 0,
  log: vi.fn(),
  ses,
  fromAddress: 'alerts@example.com',
  ...extra,
})

describe('sendEmail', () => {
  it('names the configuration set it was configured with', async () => {
    const fake = fakeSes()
    expect(await sendEmail(deps(fake.ses, { configurationSet: 'bw-alerts' }), delivery())).toMatchObject({
      kind: 'delivered',
    })
    expect(fake.sent[0]!.input.ConfigurationSetName).toBe('bw-alerts')
  })

  it('names no configuration set when there is none', async () => {
    const fake = fakeSes()
    await sendEmail(deps(fake.ses), delivery())
    expect('ConfigurationSetName' in fake.sent[0]!.input).toBe(false)
  })

  it("collapses a caller's own subject the way it collapses the one it generates", async () => {
    const fake = fakeSes()
    await sendEmail(deps(fake.ses), delivery('Large\r\n transfer'))
    expect(fake.sent[0]!.input.Content?.Simple?.Subject?.Data).toBe('Large transfer')
  })

  it('records the id SES gave the message, because nothing else can find it afterwards', async () => {
    const fake = fakeSes({ MessageId: 'ses-message-1' })
    const log = vi.fn()
    await sendEmail(deps(fake.ses, { log }), delivery())
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ messageId: 'ses-message-1' }))
  })

  it('retries a missing configuration set rather than dead-lettering the alert', async () => {
    const err = Object.assign(new Error('Configuration set <bw-alerts> does not exist.'), {
      name: 'NotFoundException',
    })
    const fake = fakeSes(err)
    const outcome = await sendEmail(deps(fake.ses, { configurationSet: 'bw-alerts' }), delivery())
    expect(outcome).toMatchObject({ kind: 'retry' })
  })

  it('calls a rejected message permanent', async () => {
    const err = Object.assign(new Error('Email address not verified nobody@example.com'), { name: 'MessageRejected' })
    expect(await sendEmail(deps(fakeSes(err).ses), delivery())).toMatchObject({ kind: 'permanent' })
  })
})
