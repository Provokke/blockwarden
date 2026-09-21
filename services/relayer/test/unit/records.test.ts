import { describe, expect, it } from 'vitest'
import { liveAttempt, toTxBody, withStatus, type Attempt, type TxRecord } from '../../src/records.js'
import { txRecord } from '../helpers/fixtures.js'

const attempt = (n: number, rejected?: string): Attempt => ({
  hash: `0x${String(n).repeat(64)}`,
  raw: '0x02',
  maxFeePerGas: '1',
  maxPriorityFeePerGas: '1',
  signedAt: n,
  ...(rejected ? { rejected } : {}),
})

const tx: TxRecord = {
  txId: 't',
  kind: 'relay',
  signerId: 's',
  chainId: 84532,
  from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  to: '0x000000000000000000000000000000000000dEaD',
  data: '0x',
  value: '1',
  gasLimit: '21000',
  status: 'submitted',
  nonce: 4,
  attempts: [attempt(1), attempt(2)],
  apiKeyHash: 'secret-hash',
  requestHash: 'r',
  enqueuedAt: 0,
  enqueues: 1,
  history: [{ status: 'queued', at: 'a' }],
  createdAt: 'a',
  updatedAt: 'b',
  version: 3,
}

describe('toTxBody', () => {
  it('shows the latest hash before mining and the mined hash after, and never internal fields', () => {
    const body = toTxBody(tx)
    expect(body).toMatchObject({ hash: attempt(2).hash, blockNumber: null, receiptStatus: null, nonce: 4 })
    expect(Object.keys(body)).not.toContain('apiKeyHash')
    expect(Object.keys(body)).not.toContain('attempts')

    const mined = {
      ...tx,
      mined: { hash: attempt(1).hash, blockNumber: 9, blockHash: attempt(3).hash, status: 'reverted' as const },
    }
    expect(toTxBody(mined)).toMatchObject({ hash: attempt(1).hash, blockNumber: 9, receiptStatus: 'reverted' })
    expect(toTxBody({ ...tx, attempts: [], nonce: undefined })).toMatchObject({ hash: null, nonce: null })
  })

  it('reports the revert data on the body, and null when there is none', () => {
    expect(toTxBody(txRecord({ revertData: '0x11fbe712' })).revertData).toBe('0x11fbe712')
    expect(toTxBody(txRecord({})).revertData).toBeNull()
  })
})

describe('withStatus', () => {
  it('appends a history entry only when the status changes', () => {
    expect(withStatus(tx, 'submitted', 'c')).toBe(tx)
    expect(withStatus(tx, 'mined', 'c').history).toEqual([...tx.history, { status: 'mined', at: 'c' }])
  })
})

describe('liveAttempt', () => {
  it('skips refused attempts', () => {
    expect(liveAttempt({ ...tx, attempts: [attempt(1), attempt(2, 'underpriced')] })).toEqual(attempt(1))
    expect(liveAttempt({ ...tx, attempts: [attempt(1, 'x')] })).toBeUndefined()
  })
})
