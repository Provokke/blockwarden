import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  checkPolicy,
  feeCap,
  MAX_DATA_BYTES,
  policySchema,
  weiToGweiCeil,
  weiToGweiFloor,
  worstCaseCostWei,
  type Policy,
} from '../../src/policy.js'

const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const TREASURY: Address = '0x000000000000000000000000000000000000bEEF'
const OTHER: Address = '0x000000000000000000000000000000000000dEaD'
const PLAIN: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

const policy: Policy = policySchema.parse({
  allowedTo: [
    { address: PLAIN },
    { address: TOKEN, selectors: ['0xa9059cbb'], transferRecipients: [TREASURY] },
    { address: OTHER, selectors: ['0x'] },
  ],
  maxGasLimit: 300_000,
  maxFeePerGas: '100000000000',
  maxPriorityFeePerGas: '2000000000',
  dailySpendCapWei: '50000000000000000',
})

const transfer = (to: Address, amount = 1n) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
const check = (to: Address, data: Hex, gasLimit = 100_000n) => checkPolicy(policy, { to, data, value: 0n, gasLimit })
const paths = (issues: { path: string }[]) => issues.map((i) => i.path)

describe('checkPolicy', () => {
  it('allows any call to an address with no selector list, whatever the case of the address', () => {
    expect(check(PLAIN.toLowerCase() as Address, '0xdeadbeef00')).toEqual([])
  })

  it('refuses an address the policy does not list', () => {
    expect(paths(check(TREASURY, '0x'))).toEqual(['to'])
  })

  it('refuses a function outside the selector list', () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TREASURY, 1n] })
    expect(check(TOKEN, approve)).toEqual([{ path: 'data', message: expect.stringContaining('0x095ea7b3') }])
  })

  it('treats calldata shorter than a selector as a plain transfer, allowed only by 0x in the list', () => {
    expect(check(OTHER, '0x')).toEqual([])
    expect(check(OTHER, '0x1234')).toEqual([])
    expect(paths(check(OTHER, '0x12345678'))).toEqual(['data'])
    expect(paths(check(TOKEN, '0x'))).toEqual(['data'])
  })

  it('allows an ERC-20 transfer only to a listed recipient', () => {
    expect(check(TOKEN, transfer(TREASURY))).toEqual([])
    expect(check(TOKEN, transfer(TREASURY.toLowerCase() as Address))).toEqual([])
    expect(check(TOKEN, transfer(OTHER))).toEqual([
      { path: 'data', message: 'the signer policy does not allow a transfer to this recipient' },
    ])
  })

  it('refuses transfer calldata that does not decode', () => {
    expect(paths(check(TOKEN, '0xa9059cbb0000'))).toEqual(['data'])
  })

  it('refuses a gas limit above the maximum and calldata above the size limit, alongside other issues', () => {
    expect(check(PLAIN, '0x', 300_000n)).toEqual([])
    expect(paths(check(PLAIN, '0x', 300_001n))).toEqual(['gasLimit'])
    const big = `0x${'00'.repeat(MAX_DATA_BYTES + 1)}` as Hex
    expect(paths(check(TREASURY, big, 300_001n))).toEqual(['data', 'gasLimit', 'to'])
  })
})

describe('policySchema', () => {
  const valid = {
    allowedTo: [{ address: PLAIN }],
    maxGasLimit: 1,
    maxFeePerGas: '10',
    maxPriorityFeePerGas: '10',
    dailySpendCapWei: '1',
  }

  it('accepts a tip equal to the fee cap and refuses one above it', () => {
    expect(policySchema.safeParse(valid).success).toBe(true)
    const result = policySchema.safeParse({ ...valid, maxPriorityFeePerGas: '11' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['maxPriorityFeePerGas'])
  })

  it('refuses an empty allowlist, a bad selector and a spend cap too large to count in gwei', () => {
    expect(policySchema.safeParse({ ...valid, allowedTo: [] }).success).toBe(false)
    expect(policySchema.safeParse({ ...valid, allowedTo: [{ address: PLAIN, selectors: ['0x1234'] }] }).success).toBe(
      false,
    )
    const huge = ((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000_000_000n).toString()
    expect(policySchema.safeParse({ ...valid, dailySpendCapWei: huge }).success).toBe(false)
  })
})

describe('spend arithmetic', () => {
  it('bounds a transaction by value plus its gas limit at the fee cap', () => {
    expect(worstCaseCostWei(policy, { value: 7n, gasLimit: 21_000n })).toBe(7n + 21_000n * 100_000_000_000n)
    expect(feeCap(policy)).toEqual({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n })
  })

  it('rounds a cost up and a cap down to whole gwei', () => {
    expect(weiToGweiCeil(1n)).toBe(1)
    expect(weiToGweiCeil(1_000_000_000n)).toBe(1)
    expect(weiToGweiCeil(1_000_000_001n)).toBe(2)
    expect(weiToGweiFloor(1_999_999_999n)).toBe(1)
  })
})
