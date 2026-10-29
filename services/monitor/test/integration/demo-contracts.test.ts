import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ANVIL_OWNER_KEY, deployDemo, type Demo } from '@blockwarden/contracts/testing'
import { compileRule, ruleInputSchema } from '@blockwarden/core'
import { GSI1 } from '@blockwarden/dynamo'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { createPublicClient, createWalletClient, http, parseEther, stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChainReader } from '../../src/chain.js'
import { runCycle, type CycleResult } from '../../src/cycle.js'
import { keys } from '../../src/keys.js'
import { MonitorStore } from '../../src/store.js'
import { startAnvil, type Anvil } from '../helpers/anvil.js'

const TAG = stringToHex('seam', { size: 32 })

// written the way an operator writes one: the event with its parameter names, the deployed address, a condition
const pingRule = (chainId: number, emitter: Hex) => ({
  chainId,
  addresses: [emitter],
  event: 'event Ping(address indexed sender, uint256 indexed id, bytes32 tag)',
  conditions: { field: 'args.id', op: 'eq', value: '42' },
  confirmation: { mode: 'finalized' },
  actions: [],
})
const balanceLowRule = (chainId: number, vault: Hex) => ({
  chainId,
  addresses: [vault],
  event: 'event BalanceLow(address indexed account, uint256 balance)',
  confirmation: { mode: 'finalized' },
  actions: [],
})

describe('the monitor against the demo contracts', () => {
  let anvil: Anvil
  let dynamo: Dynamo
  let demo: Demo
  let tableName: string
  let result: CycleResult
  // generated here, so the address the rules see is not the deployer's and cannot be confused with it
  const user = privateKeyToAccount(generatePrivateKey())
  const sent = {} as Record<'pingMatch' | 'pingOther' | 'spendAbove' | 'spendCrossing' | 'spendStillLow', Hex>

  const rows = async (ruleId: string) => {
    const { Items } = await dynamo.doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.matchesByRule(ruleId) },
      }),
    )
    return Items ?? []
  }

  beforeAll(async () => {
    ;[anvil, dynamo] = await Promise.all([startAnvil(), startDynamo()])
    demo = await deployDemo(anvil.rpcUrl)
    tableName = await dynamo.newTable()
    const store = new MonitorStore(dynamo.doc, tableName)
    const chain = createChainReader([anvil.rpcUrl])
    const startBlock = await chain.getHead()

    const now = new Date().toISOString()
    for (const [ruleId, raw] of [
      ['ping', pingRule(anvil.chainId, demo.addresses.emitter)],
      ['balance-low', balanceLowRule(anvil.chainId, demo.addresses.vault)],
    ] as const) {
      const input = ruleInputSchema.parse(raw)
      // the check scripts/put-rule.ts makes before it stores a rule
      expect(compileRule(ruleId, input).warnings).toEqual([])
      await store.putRule({ ruleId, input, active: true, createdAt: now, updatedAt: now })
    }

    const transport = http(anvil.rpcUrl)
    const reader = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 100 })
    const owner = createWalletClient({ account: privateKeyToAccount(ANVIL_OWNER_KEY), chain: foundry, transport })
    const asUser = createWalletClient({ account: user, chain: foundry, transport })
    const mined = async (hash: Hex) => {
      const receipt = await reader.waitForTransactionReceipt({ hash })
      expect(receipt.status).toBe('success')
      return hash
    }
    const { emitter, vault } = demo.addresses
    const { emitter: emitterAbi, vault: vaultAbi } = demo.abis

    await mined(await owner.sendTransaction({ to: user.address, value: parseEther('1') }))
    await mined(await owner.writeContract({ address: vault, abi: vaultAbi, functionName: 'fund', args: [1000n] }))
    sent.pingMatch = await mined(
      await asUser.writeContract({ address: emitter, abi: emitterAbi, functionName: 'ping', args: [42n, TAG] }),
    )
    sent.pingOther = await mined(
      await asUser.writeContract({ address: emitter, abi: emitterAbi, functionName: 'ping', args: [7n, TAG] }),
    )
    await mined(
      await asUser.writeContract({ address: vault, abi: vaultAbi, functionName: 'topUp', args: [user.address] }),
    )
    // 500 credited against a threshold of 100: the spends leave 200, then 50, which crosses, then 30, still low
    sent.spendAbove = await mined(
      await asUser.writeContract({ address: vault, abi: vaultAbi, functionName: 'spend', args: [300n] }),
    )
    sent.spendCrossing = await mined(
      await asUser.writeContract({ address: vault, abi: vaultAbi, functionName: 'spend', args: [150n] }),
    )
    sent.spendStillLow = await mined(
      await asUser.writeContract({ address: vault, abi: vaultAbi, functionName: 'spend', args: [20n] }),
    )

    // Anvil reports finalized as head minus 64, so every log above is final for the durable scan
    await anvil.mine(64)
    result = await runCycle({ chainId: anvil.chainId, chain, store, maxRange: 2000, timeBudgetMs: 60_000, startBlock })
  })

  afterAll(async () => {
    await Promise.all([anvil?.stop(), dynamo?.stop()])
  })

  it('scans the demo logs and writes one final match per rule', () => {
    expect(result).toMatchObject({ status: 'ok', final: 2, provisional: 0, ruleSkips: 0, ruleWarnings: 0 })
  })

  it('matches the ping with id 42 and decodes what DemoEmitter emitted', async () => {
    const matches = await rows('ping')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      status: 'final',
      chainId: anvil.chainId,
      address: demo.addresses.emitter.toLowerCase(),
      transactionHash: sent.pingMatch,
      args: { sender: user.address, id: '42', tag: TAG },
    })
  })

  it('leaves the ping with another id unmatched', async () => {
    expect((await rows('ping')).map((row) => row.transactionHash)).not.toContain(sent.pingOther)
  })

  it('matches BalanceLow once, on the spend that crosses the threshold', async () => {
    const matches = await rows('balance-low')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      status: 'final',
      address: demo.addresses.vault.toLowerCase(),
      transactionHash: sent.spendCrossing,
      args: { account: user.address, balance: '50' },
    })
    const hashes = matches.map((row) => row.transactionHash)
    // one spend stayed above the threshold and one started below it; neither crossed
    expect(hashes).not.toContain(sent.spendAbove)
    expect(hashes).not.toContain(sent.spendStillLow)
  })
})
