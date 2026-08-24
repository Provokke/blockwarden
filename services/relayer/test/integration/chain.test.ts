import { encodeFunctionData, keccak256, parseGwei, type Hex, type LocalAccount } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRelayerChain, EstimateError, type RelayerChain } from '../../src/chain.js'
import { startAnvil, TARGET_ABI, type Anvil } from '../helpers/anvil.js'
import { localAccount } from '../helpers/fixtures.js'

// the same classification the unit tests check, against the messages a real node sends
describe('createRelayerChain against Anvil', () => {
  let anvil: Anvil
  let chain: RelayerChain
  let account: LocalAccount
  let target: Hex

  const sign = (nonce: number, fee = parseGwei('3'), tip = parseGwei('1'), gas = 21_000n) =>
    account.signTransaction({
      type: 'eip1559',
      chainId: anvil.chainId,
      nonce,
      to: account.address,
      value: 0n,
      gas,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: tip,
    })

  beforeAll(async () => {
    anvil = await startAnvil()
    target = await anvil.deployTarget()
    chain = createRelayerChain(anvil.chainId, [anvil.rpcUrl])
  })

  afterAll(async () => {
    await anvil?.stop()
  })

  beforeEach(async () => {
    account = await localAccount(generatePrivateKey())
    await anvil.setBalance(account.address, 10n ** 18n)
    await anvil.setAutomine(true)
  })

  it('accepts a transaction, knows it while pending, and returns its receipt once mined', async () => {
    await anvil.setAutomine(false)
    const raw = await sign(0)
    const hash = keccak256(raw)
    expect(await chain.getReceipt(hash)).toBeUndefined()
    expect(await chain.isKnown(hash)).toBe(false)
    expect(await chain.send(raw)).toEqual({ kind: 'accepted' })
    expect(await chain.isKnown(hash)).toBe(true)
    expect(await chain.getNonce(account.address, 'pending')).toBe(1)
    expect(await chain.getNonce(account.address, 'latest')).toBe(0)
    await anvil.mine(1)
    expect(await chain.getReceipt(hash)).toMatchObject({
      hash,
      blockNumber: await chain.getBlockNumber(),
      status: 'success',
    })
  })

  it('classifies what the node answers to a resend, a spent nonce, a weak replacement, a poor sender and too little gas', async () => {
    await anvil.setAutomine(false)
    const first = await sign(0)
    await chain.send(first)
    expect(await chain.send(first)).toEqual({ kind: 'already-known' })
    // Anvil only needs a higher fee cap to replace; geth also needs 10% on both fields, which core's bump math covers
    expect((await chain.send(await sign(0, parseGwei('3'), parseGwei('2')))).kind).toBe('underpriced')
    await anvil.mine(1)
    expect((await chain.send(await sign(0))).kind).toBe('nonce-too-low')
    expect((await chain.send(await sign(1, parseGwei('3'), parseGwei('1'), 20_000n))).kind).toBe('rejected')

    const poor = await localAccount(generatePrivateKey())
    const raw = await poor.signTransaction({
      type: 'eip1559',
      chainId: anvil.chainId,
      nonce: 0,
      to: poor.address,
      gas: 21_000n,
      maxFeePerGas: parseGwei('3'),
      maxPriorityFeePerGas: parseGwei('1'),
    })
    expect((await chain.send(raw)).kind).toBe('insufficient-funds')
  })

  it('returns fee estimates a node accepts and gas estimates for a call', async () => {
    const fees = await chain.estimateFees()
    expect(fees.maxPriorityFeePerGas <= fees.maxFeePerGas).toBe(true)
    const data = encodeFunctionData({ abi: TARGET_ABI, functionName: 'ping', args: [1n] })
    expect(await chain.estimateGas({ from: account.address, to: target, data, value: 0n })).toBeGreaterThan(21_000n)
    expect(await chain.getBalance(account.address)).toBe(10n ** 18n)
  })

  it('reports a reverting estimate with its revert data, and an unreachable node as unavailable', async () => {
    const data = encodeFunctionData({ abi: TARGET_ABI, functionName: 'fail', args: [9n] })
    const reverted = await chain.estimateGas({ from: account.address, to: target, data, value: 0n }).catch((e) => e)
    expect(reverted).toBeInstanceOf(EstimateError)
    expect(reverted).toMatchObject({ kind: 'reverted' })
    expect((reverted as EstimateError).revertData).toMatch(/^0x[0-9a-f]{8}0{62}09$/)

    const dead = createRelayerChain(anvil.chainId, ['http://127.0.0.1:9'], 1_000)
    const unavailable = await dead.estimateGas({ from: account.address, to: target, data, value: 0n }).catch((e) => e)
    expect(unavailable).toMatchObject({ kind: 'unavailable' })
    expect((await dead.send(await sign(0))).kind).toBe('unknown')
  })

  it('refuses to build without an RPC URL', () => {
    expect(() => createRelayerChain(1, [])).toThrow(/no RPC URLs/)
  })
})
