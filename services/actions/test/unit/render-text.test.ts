import { describe, expect, it } from 'vitest'
import { summarise } from '../../src/senders/render-text.js'

const matchPayload = JSON.stringify({
  id: 'dlv_1',
  type: 'match.final',
  createdAt: '2026-09-20T10:19:00.000Z',
  specVersion: 1,
  data: {
    matchKey: '0xabc',
    ruleId: 'rule-1',
    status: 'final',
    chainId: 8453,
    address: '0x8335',
    transactionHash: '0xdead',
    blockNumber: 12_345_678,
    logIndex: 4,
    eventName: 'Transfer',
    args: { from: '0x44', to: '0x55', value: '1000000000000000000' },
  },
})

const txPayload = JSON.stringify({
  id: 'dlv_2',
  type: 'tx.mined',
  createdAt: 'now',
  specVersion: 1,
  data: {
    txId: 'tx-1',
    chainId: 84_532,
    status: 'mined',
    hash: '0xbeef',
    blockNumber: 99,
    receiptStatus: 'reverted',
    reference: 'sub_1',
  },
})

describe('summarise', () => {
  it('names the event and the chain in a match subject', () => {
    const { subject } = summarise(matchPayload)
    expect(subject).toBe('Blockwarden: Transfer on chain 8453 (final)')
  })

  it('names the transaction and its receipt in a transaction subject', () => {
    expect(summarise(txPayload).subject).toBe('Blockwarden: tx.mined on chain 84532 (reverted)')
  })

  it('lists every argument in the text, with the numbers as they were sent', () => {
    const { text } = summarise(matchPayload)
    expect(text).toContain('value: 1000000000000000000')
    expect(text).toContain('transactionHash: 0xdead')
    expect(text).toContain('blockNumber: 12345678')
  })

  it('escapes the html body, so a value cannot inject markup', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'match.final',
      createdAt: 'n',
      data: { eventName: '<img src=x>', args: {}, chainId: 1, status: 'final' },
    })
    const { html, subject } = summarise(payload)
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img src=x>')
    // the subject is plain text and is not escaped, but it must not carry a newline into a header
    expect(subject).not.toContain('\n')
  })

  it('cuts a very long body rather than sending a megabyte of text', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'match.final',
      createdAt: 'n',
      data: { eventName: 'E', chainId: 1, status: 'final', args: { blob: 'x'.repeat(100_000) } },
    })
    expect(summarise(payload).text.length).toBeLessThanOrEqual(4_096)
  })

  it('does not throw on a payload it does not recognise', () => {
    const { subject, text } = summarise(
      JSON.stringify({ id: 'd', type: 'custom.thing', createdAt: 'n', data: 'hello' }),
    )
    expect(subject).toContain('custom.thing')
    expect(text).toContain('hello')
  })
})
