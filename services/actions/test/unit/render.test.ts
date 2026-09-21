import { isMatchEvent, isTxEvent, verifyWebhook, signWebhook, WEBHOOK_SPEC_VERSION } from '@blockwarden/relayer-client'
import { describe, expect, it } from 'vitest'
import { matchEventData, renderEvent, txEventData } from '../../src/render.js'
import { matchRow, txRow } from '../helpers/images.js'

const rule = { event: 'event Transfer(address indexed from, address indexed to, uint256 value)', eventName: 'Transfer' }

describe('matchEventData', () => {
  it('builds a body the published guard accepts', () => {
    const data = matchEventData(matchRow({ status: 'final', finalizedAt: '2026-09-20T10:19:00.000Z' }), rule)
    const payload = renderEvent({ deliveryId: 'dlv_1', type: 'match.final', createdAt: 'now', data })
    expect(isMatchEvent(JSON.parse(payload))).toBe(true)
    expect(data.eventName).toBe('Transfer')
    expect(data.args.value).toBe('1000000000000000000')
    expect(data.finalizedAt).toBe('2026-09-20T10:19:00.000Z')
  })

  it('reports finalizedAt as null while the match is provisional', () => {
    expect(matchEventData(matchRow({ status: 'provisional' }), rule).finalizedAt).toBeNull()
  })

  it('turns a bigint or a number in args into a decimal string rather than throwing', () => {
    const data = matchEventData(matchRow({ args: { value: 99999999999999999999999n, tick: -201_234 } }), rule)
    expect(data.args.value).toBe('99999999999999999999999')
    // an int24 decodes to a JS number, which the guard refuses, so the sender is what makes it a string
    expect(data.args.tick).toBe('-201234')
    expect(() => JSON.stringify(data)).not.toThrow()
  })

  it('carries a nested tuple through as an object', () => {
    const data = matchEventData(matchRow({ args: { permission: { spender: '0xab', allowance: '5' } } }), rule)
    expect(data.args.permission).toEqual({ spender: '0xab', allowance: '5' })
  })

  it('maps each field from the row to its own field on the output, not a same-shaped neighbour', () => {
    const matchKey = `0x${'1'.repeat(64)}`
    const ruleId = 'rule-9'
    const chainId = 84_532
    const blockNumber = 111
    const blockHash = `0x${'2'.repeat(64)}`
    const transactionHash = `0x${'3'.repeat(64)}`
    const logIndex = 5
    const ordinal = 6
    const firstSeenAt = '2026-09-20T11:00:00.000Z'
    const data = matchEventData(
      matchRow({ matchKey, ruleId, chainId, blockNumber, blockHash, transactionHash, logIndex, ordinal, firstSeenAt }),
      rule,
    )
    expect(data.matchKey).toBe(matchKey)
    expect(data.ruleId).toBe(ruleId)
    expect(data.chainId).toBe(chainId)
    expect(data.blockNumber).toBe(blockNumber)
    expect(data.blockHash).toBe(blockHash)
    expect(data.transactionHash).toBe(transactionHash)
    expect(data.logIndex).toBe(logIndex)
    expect(data.ordinal).toBe(ordinal)
    expect(data.firstSeenAt).toBe(firstSeenAt)
  })
})

describe('renderEvent', () => {
  it('writes the envelope the schema publishes', () => {
    const payload = renderEvent({
      deliveryId: 'dlv_1',
      type: 'tx.mined',
      createdAt: '2026-09-20T10:00:00.000Z',
      data: { a: 1 },
    })
    expect(JSON.parse(payload)).toEqual({
      id: 'dlv_1',
      type: 'tx.mined',
      createdAt: '2026-09-20T10:00:00.000Z',
      specVersion: WEBHOOK_SPEC_VERSION,
      data: { a: 1 },
    })
  })

  it('renders a transaction body the published guard accepts', async () => {
    const payload = renderEvent({
      deliveryId: 'dlv_2',
      type: 'tx.mined',
      createdAt: 'now',
      data: txEventData(
        txRow({ status: 'mined', mined: { hash: '0x99', blockNumber: 12, blockHash: '0x98', status: 'success' } }),
      ),
    })
    const nowMs = 1789000000000
    const signature = await signWebhook({ payload, secret: 's', nowMs })
    const event = await verifyWebhook({ payload, signature, secret: 's', nowMs })
    expect(isTxEvent(event)).toBe(true)
  })
})

describe('txEventData', () => {
  it('maps each field from the row to its own field on the output, not a same-shaped neighbour', () => {
    const mined = { hash: `0x${'a'.repeat(64)}`, blockNumber: 111, blockHash: `0x${'b'.repeat(64)}`, status: 'success' }
    const nonce = 7
    const data = txEventData(txRow({ status: 'mined', nonce, mined }))
    expect(data.hash).toBe(mined.hash)
    expect(data.blockHash).toBe(mined.blockHash)
    expect(data.blockNumber).toBe(mined.blockNumber)
    expect(data.nonce).toBe(nonce)
  })
})
