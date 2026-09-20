import { TX_STATUSES, type RelayerTxBody, type SignersBody } from './types.js'

type Check = (value: unknown) => boolean

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
  fillerTxId: nullable(string),
  idempotencyKey: nullable(string),
  reference: nullable(string),
  dependsOn: nullable(string),
  createdAt: string,
  updatedAt: string,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isTxBody(value: unknown): value is RelayerTxBody {
  return isObject(value) && Object.entries(TX_BODY).every(([key, check]) => check(value[key]))
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
