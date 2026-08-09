import type { Hex } from 'viem'

export type RawLog = {
  address: Hex
  topics: Hex[]
  data: Hex
  blockNumber: number
  blockHash: Hex
  transactionHash: Hex
  logIndex: number
}
