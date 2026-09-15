import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from 'viem'
import type { RawLog } from '../src/types.js'

export const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex
export const ALICE = '0x00000000000000000000000000000000000000AA' as Hex
export const BOB = '0x00000000000000000000000000000000000000bb' as Hex
export const TRANSFER = 'event Transfer(address indexed from, address indexed to, uint256 value)'

const erc20Transfer = parseAbiItem(TRANSFER)
const erc721Transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')

type LogPosition = { address?: Hex; blockNumber?: number; blockHash?: Hex; logIndex?: number }

function position(p: LogPosition): Omit<RawLog, 'topics' | 'data'> {
  return {
    address: p.address ?? TOKEN,
    blockNumber: p.blockNumber ?? 1,
    blockHash: p.blockHash ?? `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    logIndex: p.logIndex ?? 0,
  }
}

export function erc20Log(value: bigint, p: LogPosition = {}): RawLog {
  const topics = encodeEventTopics({ abi: [erc20Transfer], eventName: 'Transfer', args: { from: ALICE, to: BOB } })
  return { ...position(p), topics: topics as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) }
}

export function erc721Log(tokenId: bigint, p: LogPosition = {}): RawLog {
  const topics = encodeEventTopics({
    abi: [erc721Transfer],
    eventName: 'Transfer',
    args: { from: ALICE, to: BOB, tokenId },
  })
  return { ...position(p), topics: topics as Hex[], data: '0x' }
}
