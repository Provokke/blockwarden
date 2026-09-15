import { encodeAbiParameters, keccak256, type Hex } from 'viem'

export function matchKey(chainId: number, transactionHash: Hex, ordinal: number, ruleId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'string' }],
      [BigInt(chainId), transactionHash, ordinal, ruleId],
    ),
  )
}
