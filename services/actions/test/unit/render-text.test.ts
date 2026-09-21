import { describe, expect, it } from 'vitest'
import { subjectLine, summarise } from '../../src/senders/render-text.js'

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

  it('cannot be made to forge a field with a newline inside a decoded argument', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'match.final',
      createdAt: 'n',
      data: {
        eventName: 'Transfer',
        chainId: 1,
        status: 'final',
        args: { memo: 'nothing here\ntransactionHash: 0xfeed\r\nvalue: 1' },
      },
    })
    const lines = summarise(payload).text.split('\n')
    expect(lines.some((line) => line.startsWith('transactionHash:'))).toBe(false)
    expect(lines.some((line) => line.startsWith('value:'))).toBe(false)
    // the value itself is still there, on the one line it belongs to
    expect(lines.some((line) => line.startsWith('args.memo: ') && line.includes('nothing here'))).toBe(true)
  })

  it("cannot be made to forge a field with a newline inside a transaction's reference", () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'tx.mined',
      createdAt: 'n',
      data: { txId: 'tx-1', chainId: 1, status: 'mined', hash: '0xbeef', reference: 'sub_1\nreceiptStatus: success' },
    })
    const lines = summarise(payload).text.split('\n')
    expect(lines.filter((line) => line.startsWith('receiptStatus:'))).toEqual([])
    expect(lines.some((line) => line.startsWith('reference: sub_1'))).toBe(true)
  })

  it('keeps the summary fields when a transaction carries kilobytes of calldata', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'tx.mined',
      createdAt: 'n',
      data: {
        txId: 'tx-1',
        kind: 'send',
        signerId: 'signer-1',
        chainId: 8453,
        from: '0x11',
        to: '0x22',
        data: `0x${'ab'.repeat(2_048)}`,
        value: '0',
        gasLimit: '100000',
        status: 'mined',
        nonce: 7,
        hash: '0xbeef',
        blockNumber: 99,
        receiptStatus: 'success',
        reference: 'sub_1',
      },
    })
    const { text } = summarise(payload)
    expect(text).toContain('hash: 0xbeef')
    expect(text).toContain('receiptStatus: success')
    expect(text.length).toBeLessThanOrEqual(4_096)
  })

  it('does not cut a surrogate pair in half when it caps the body', () => {
    const args = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}`, '\u{1f600}'.repeat(100)]))
    const payload = JSON.stringify({
      id: 'd',
      type: 'match.final',
      createdAt: 'n',
      data: { eventName: 'E', chainId: 1, status: 'final', args },
    })
    const { text } = summarise(payload)
    expect(text.length).toBeLessThanOrEqual(4_096)
    const last = text.charCodeAt(text.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
  })

  it('leaves out the empty brackets when a transaction has neither status', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'tx.submitted',
      createdAt: 'n',
      data: { txId: 'tx-1', chainId: 1 },
    })
    expect(summarise(payload).subject).toBe('Blockwarden: tx.submitted on chain 1')
  })

  it('caps the subject it generates rather than writing a header of any length', () => {
    const payload = JSON.stringify({
      id: 'd',
      type: 'match.final',
      createdAt: 'n',
      data: { eventName: 'E'.repeat(500), chainId: 1, status: 'final' },
    })
    expect(summarise(payload).subject.length).toBeLessThanOrEqual(203)
  })
})

describe('subjectLine', () => {
  it('collapses whitespace so a caller cannot fold a header', () => {
    expect(subjectLine('  Large\r\n transfer  ')).toBe('Large transfer')
  })

  it('caps a subject of any length', () => {
    expect(subjectLine('s'.repeat(500)).length).toBeLessThanOrEqual(203)
  })
})
