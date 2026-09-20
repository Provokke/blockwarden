import { MATCH_STATUSES, TX_STATUSES, type MatchEventData, type RelayerTxBody, type SignersBody } from './types.js'

type Check = (value: unknown) => boolean

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const string: Check = (v) => typeof v === 'string'
const integer: Check = (v) => Number.isSafeInteger(v)
// BigInt('') is 0n, so an empty or non-decimal amount must be refused before it gets there
const decimal: Check = (v) => typeof v === 'string' && /^\d+$/.test(v)
const hex: Check = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v) =>
    values.includes(v)
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v)
// a body from a relayer older than this field has no revertData at all, and refusing it would make a
// 0.2.0 client unable to read a 0.1.x relayer's webhooks
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v)

const decodedValue: Check = (v) => {
  if (typeof v === 'string' || typeof v === 'boolean') return true
  if (Array.isArray(v)) return v.every(decodedValue)
  return isObject(v) && Object.values(v).every(decodedValue)
}
const decodedArgs: Check = (v) => isObject(v) && Object.values(v).every(decodedValue)

const TX_BODY: Record<keyof RelayerTxBody, Check> = {
  txId: string,
  kind: oneOf('relay', 'filler'),
  signerId: string,
  chainId: integer,
  from: hex,
  to: hex,
  data: hex,
  value: decimal,
  gasLimit: decimal,
  status: oneOf(...TX_STATUSES),
  nonce: nullable(integer),
  hash: nullable(hex),
  blockNumber: nullable(integer),
  blockHash: nullable(hex),
  receiptStatus: nullable(oneOf('success', 'reverted')),
  error: nullable(string),
  revertData: optional(nullable(hex)),
  fillerTxId: nullable(string),
  idempotencyKey: nullable(string),
  reference: nullable(string),
  dependsOn: nullable(string),
  createdAt: string,
  updatedAt: string,
}

export function isTxBody(value: unknown): value is RelayerTxBody {
  return isObject(value) && Object.entries(TX_BODY).every(([key, check]) => check(value[key]))
}

const MATCH_BODY: Record<keyof MatchEventData, Check> = {
  matchKey: hex,
  ruleId: string,
  status: oneOf(...MATCH_STATUSES),
  chainId: integer,
  address: hex,
  transactionHash: hex,
  blockNumber: integer,
  blockHash: hex,
  logIndex: integer,
  ordinal: integer,
  event: string,
  eventName: string,
  args: decodedArgs,
  firstSeenAt: string,
  finalizedAt: nullable(string),
}

export function isMatchBody(value: unknown): value is MatchEventData {
  return isObject(value) && Object.entries(MATCH_BODY).every(([key, check]) => check(value[key]))
}

export function isSignersBody(value: unknown): value is SignersBody {
  return (
    isObject(value) &&
    Array.isArray(value.signers) &&
    value.signers.every(
      (s: unknown) =>
        isObject(s) &&
        string(s.signerId) &&
        hex(s.address) &&
        Array.isArray(s.chainIds) &&
        s.chainIds.every((id) => integer(id)),
    )
  )
}
