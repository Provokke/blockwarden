import { describe, expect, it, vi } from 'vitest'
import { allDead, checkRedriveArgs, describeTarget, positiveInt, redactedUrl } from '../../scripts/lib.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { DeadPage } from '../../src/store.js'

const SLACK = 'https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-secret'

describe('redactedUrl', () => {
  it('keeps the origin and drops the part of the path that is the credential', () => {
    for (const raw of [SLACK, DISCORD]) {
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
    expect(describeTarget({ channel: 'webhook', target: { channel: 'webhook', url: SLACK } })).toBe(redactedUrl(SLACK))
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
