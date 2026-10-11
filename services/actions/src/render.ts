import {
  WEBHOOK_SPEC_VERSION,
  type DecodedValue,
  type MatchEventData,
  type RelayerTxBody,
} from '@blockwarden/relayer-client'
import { jsonSafe, type Row } from './stream.js'

type Mined = { hash?: unknown; blockNumber?: unknown; blockHash?: unknown; status?: unknown }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))
const orNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export function matchEventData(row: Row, rule: { event: string; eventName: string }): MatchEventData {
  return {
    matchKey: str(row.matchKey) as MatchEventData['matchKey'],
    ruleId: str(row.ruleId),
    status: row.status as MatchEventData['status'],
    chainId: num(row.chainId),
    address: str(row.address) as MatchEventData['address'],
    transactionHash: str(row.transactionHash) as MatchEventData['transactionHash'],
    blockNumber: num(row.blockNumber),
    blockHash: str(row.blockHash) as MatchEventData['blockHash'],
    logIndex: num(row.logIndex),
    ordinal: num(row.ordinal),
    event: rule.event,
    eventName: rule.eventName,
    // the monitor stores decoded arguments with bigints already turned into strings, but not the numbers viem
    // returns for an integer of 48 bits or fewer; jsonSafe turns those into the decimal strings the schema
    // publishes, and covers a record written before toStorable and a number set
    args: jsonSafe(row.args ?? {}) as Record<string, DecodedValue>,
    firstSeenAt: str(row.firstSeenAt),
    finalizedAt: orNull(row.finalizedAt),
  }
}

// the same body GET /v1/relayer/txs/{txId} returns, built from the stream image rather than from the relayer's
// own record type, because this service does not import the relayer
export function txEventData(row: Row): RelayerTxBody {
  const mined = (row.mined ?? {}) as Mined
  const attempts = Array.isArray(row.attempts) ? (row.attempts as { hash?: unknown }[]) : []
  const latest = attempts.at(-1)
  return {
    txId: str(row.txId),
    kind: row.kind as RelayerTxBody['kind'],
    signerId: str(row.signerId),
    chainId: num(row.chainId),
    from: str(row.from) as RelayerTxBody['from'],
    to: str(row.to) as RelayerTxBody['to'],
    data: str(row.data) as RelayerTxBody['data'],
    value: str(row.value),
    gasLimit: str(row.gasLimit),
    status: row.status as RelayerTxBody['status'],
    nonce: typeof row.nonce === 'number' ? row.nonce : null,
    hash: (orNull(mined.hash) ?? orNull(latest?.hash)) as RelayerTxBody['hash'],
    blockNumber: typeof mined.blockNumber === 'number' ? mined.blockNumber : null,
    blockHash: orNull(mined.blockHash) as RelayerTxBody['blockHash'],
    receiptStatus: (orNull(mined.status) as RelayerTxBody['receiptStatus']) ?? null,
    error: orNull(row.error),
    revertData: orNull(row.revertData) as RelayerTxBody['revertData'],
    fillerTxId: orNull(row.fillerTxId),
    idempotencyKey: orNull(row.idempotencyKey),
    reference: orNull(row.reference),
    dependsOn: orNull(row.dependsOn),
    createdAt: str(row.createdAt),
    updatedAt: str(row.updatedAt),
  }
}

export function renderEvent(input: { deliveryId: string; type: string; createdAt: string; data: unknown }): string {
  return JSON.stringify({
    id: input.deliveryId,
    type: input.type,
    createdAt: input.createdAt,
    specVersion: WEBHOOK_SPEC_VERSION,
    data: input.data,
  })
}
