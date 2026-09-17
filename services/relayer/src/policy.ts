import type { Fees } from '@blockwarden/core'
import { decodeFunctionData, erc20Abi, isAddressEqual, size, slice, type Address, type Hex } from 'viem'
import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
const selector = z.string().regex(/^0x[0-9a-fA-F]{8}$/, 'expected a 4-byte function selector')
const wei = z.string().regex(/^\d{1,78}$/, 'expected a decimal amount of wei')

// ERC-20 transfer(address,uint256)
export const TRANSFER_SELECTOR = '0xa9059cbb'

// the largest calldata a transaction may carry: every signed attempt stores its raw bytes on the one item,
// and a DynamoDB item is capped at 400 KB
export const MAX_DATA_BYTES = 8 * 1024

export const policySchema = z
  .object({
    allowedTo: z
      .array(
        z.object({
          address,
          // when present, only these functions may be called on this contract; '0x' in the list allows plain transfers
          selectors: z.array(z.union([selector, z.literal('0x')])).optional(),
          // when present, an ERC-20 transfer on this contract may only send to these addresses
          transferRecipients: z.array(address).optional(),
        }),
      )
      .min(1),
    maxGasLimit: z.number().int().positive(),
    maxFeePerGas: wei,
    maxPriorityFeePerGas: wei,
    dailySpendCapWei: wei,
  })
  .refine((p) => BigInt(p.maxPriorityFeePerGas) <= BigInt(p.maxFeePerGas), {
    message: 'maxPriorityFeePerGas cannot exceed maxFeePerGas',
    path: ['maxPriorityFeePerGas'],
  })
  .refine((p) => BigInt(p.dailySpendCapWei) / 1_000_000_000n <= BigInt(Number.MAX_SAFE_INTEGER), {
    message: 'dailySpendCapWei is too large to count in gwei',
    path: ['dailySpendCapWei'],
  })

export type Policy = z.infer<typeof policySchema>

export type PolicyIssue = { path: string; message: string }

export type PolicyRequest = { to: Address; data: Hex; value: bigint; gasLimit: bigint }

export function checkPolicy(policy: Policy, request: PolicyRequest): PolicyIssue[] {
  const issues: PolicyIssue[] = []
  if (size(request.data) > MAX_DATA_BYTES) {
    issues.push({ path: 'data', message: `calldata is larger than ${MAX_DATA_BYTES} bytes` })
  }
  if (request.gasLimit > BigInt(policy.maxGasLimit)) {
    issues.push({ path: 'gasLimit', message: `gas limit is above the policy maximum of ${policy.maxGasLimit}` })
  }
  const target = policy.allowedTo.find((t) => isAddressEqual(t.address as Address, request.to))
  if (!target) {
    issues.push({ path: 'to', message: 'the signer policy does not allow this address' })
    return issues
  }
  const fn = size(request.data) >= 4 ? slice(request.data, 0, 4).toLowerCase() : '0x'
  if (target.selectors && !target.selectors.some((s) => s.toLowerCase() === fn)) {
    issues.push({ path: 'data', message: `the signer policy does not allow calling ${fn} on this address` })
  }
  if (target.transferRecipients && fn === TRANSFER_SELECTOR) {
    let recipient: Address | undefined
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: request.data })
      if (decoded.functionName === 'transfer') recipient = decoded.args[0]
    } catch {
      recipient = undefined
    }
    if (!recipient || !target.transferRecipients.some((r) => isAddressEqual(r as Address, recipient))) {
      issues.push({ path: 'data', message: 'the signer policy does not allow a transfer to this recipient' })
    }
  }
  return issues
}

export function feeCap(policy: Policy): Fees {
  return { maxFeePerGas: BigInt(policy.maxFeePerGas), maxPriorityFeePerGas: BigInt(policy.maxPriorityFeePerGas) }
}

// Every signature, replacements included, stays under the policy fee cap, so this bounds what the transaction
// can cost however many times it is bumped. The filler that takes a failed nonce is not counted.
export function worstCaseCostWei(policy: Policy, request: { value: bigint; gasLimit: bigint }): bigint {
  return request.value + request.gasLimit * BigInt(policy.maxFeePerGas)
}

const GWEI = 1_000_000_000n

// the daily counter is kept in gwei so it stays a DynamoDB number that JavaScript reads back exactly
export function weiToGweiCeil(wei: bigint): number {
  return Number((wei + GWEI - 1n) / GWEI)
}

export function weiToGweiFloor(wei: bigint): number {
  return Number(wei / GWEI)
}
