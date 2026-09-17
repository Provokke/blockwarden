export type Hex = `0x${string}`
export type Address = `0x${string}`

export const TX_STATUSES = ['queued', 'submitted', 'mined', 'confirmed', 'failed', 'cancelled'] as const
export type TxStatus = (typeof TX_STATUSES)[number]

// a filler is the 0-value self-transfer that takes the nonce of a transaction that failed after its nonce was reserved
export type TxKind = 'relay' | 'filler'

export type RelayRequest = {
  signerId: string
  chainId: number
  to: Address
  data: Hex
  value?: bigint
  gasLimit?: bigint
  // the same key from the same API key returns the original transaction instead of sending a second one
  idempotencyKey: string
  // free text of up to 128 characters, stored and returned with the transaction
  reference?: string
  // an earlier txId: this one is not estimated or signed until that one is confirmed and succeeded, and it fails
  // if that one does not succeed; gasLimit is required, because there is no estimate to derive it from
  dependsOn?: string
}

export type RelayerTx = {
  txId: string
  kind: TxKind
  signerId: string
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: bigint
  gasLimit: bigint
  status: TxStatus
  nonce: number | null
  // the latest signed hash; once mined, the hash that was mined
  hash: Hex | null
  blockNumber: number | null
  blockHash: Hex | null
  // set once mined: a mined transaction can still have reverted
  receiptStatus: 'success' | 'reverted' | null
  error: string | null
  // on a failed transaction, the filler that took its nonce
  fillerTxId: string | null
  idempotencyKey: string | null
  reference: string | null
  dependsOn: string | null
  createdAt: string
  updatedAt: string
}

export type Signer = {
  signerId: string
  address: Address
  chainIds: number[]
}

// the JSON bodies on the wire, where bigints travel as decimal strings
export type RelayRequestBody = Omit<RelayRequest, 'value' | 'gasLimit'> & { value?: string; gasLimit?: string }
export type RelayerTxBody = Omit<RelayerTx, 'value' | 'gasLimit'> & { value: string; gasLimit: string }
export type SignersBody = { signers: Signer[] }

export type ApiIssue = { path: string; message: string }

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    issues?: ApiIssue[]
    // the raw revert data when eth_estimateGas reverted, for decoding custom errors
    revertData?: Hex
  }
}
