import { CreateEmailIdentityCommand } from '@aws-sdk/client-sesv2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendEmail } from '../../src/senders/email.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { SenderDeps } from '../../src/senders/types.js'
import { startMoto } from '../helpers/store.js'

let moto: Awaited<ReturnType<typeof startMoto>>

beforeAll(async () => {
  moto = await startMoto()
  await moto.ses.send(new CreateEmailIdentityCommand({ EmailIdentity: 'alerts@example.com' }))
}, 180_000)

afterAll(async () => {
  await moto.stop()
})

const delivery = (to: string[], subject?: string): DeliveryRecord => ({
  deliveryId: 'dlv_mail',
  subject: 'MATCH#0x1',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'email',
  target: { channel: 'email', to, ...(subject ? { subject } : {}) },
  payload: JSON.stringify({
    id: 'dlv_mail',
    type: 'match.final',
    createdAt: 'now',
    specVersion: 1,
    data: { eventName: 'Transfer', chainId: 8453, status: 'final', args: { value: '1000000000000000000' } },
  }),
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

describe('sendEmail', () => {
  const deps = (): SenderDeps => ({
    secrets: { read: async () => ['x'] },
    now: () => 0,
    log: () => {},
    ses: moto.ses,
    fromAddress: 'alerts@example.com',
  })

  it('sends to every recipient from the verified address', async () => {
    expect(await sendEmail(deps(), delivery(['ops@example.com', 'sre@example.com']))).toEqual({ kind: 'delivered' })
    const sent = (await moto.sentEmails()).at(-1)!
    expect(sent.source).toBe('alerts@example.com')
    expect(sent.destinations.ToAddresses).toEqual(['ops@example.com', 'sre@example.com'])
    expect(sent.subject).toBe('Blockwarden: Transfer on chain 8453 (final)')
    // moto keeps one body and prefers the html part
    expect(sent.body).toContain('1000000000000000000')
  })

  it("uses the action's own subject when it has one", async () => {
    await sendEmail(deps(), delivery(['ops@example.com'], 'Large transfer'))
    expect((await moto.sentEmails()).at(-1)!.subject).toBe('Large transfer')
  })

  it("folds a caller's own subject onto one line before the provider sees it", async () => {
    await sendEmail(deps(), delivery(['ops@example.com'], 'Large\r\n transfer'))
    expect((await moto.sentEmails()).at(-1)!.subject).toBe('Large transfer')
  })

  it('calls an unverified sender a permanent failure', async () => {
    const outcome = await sendEmail({ ...deps(), fromAddress: 'nobody@example.com' }, delivery(['ops@example.com']))
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('MessageRejected')
  })

  it('calls a missing sender address a permanent failure and sends nothing', async () => {
    const before = (await moto.sentEmails()).length
    expect((await sendEmail({ ...deps(), fromAddress: undefined }, delivery(['ops@example.com']))).kind).toBe(
      'permanent',
    )
    expect((await moto.sentEmails()).length).toBe(before)
  })
})
