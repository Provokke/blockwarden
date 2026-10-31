import {
  ANVIL_OWNER_KEY,
  deployDemo,
  FORWARD_REQUEST_TYPES,
  FORWARDER_NAME,
  signForwardRequest,
  type Demo,
} from '@blockwarden/contracts/testing'
import { MAX_RELAY_DATA_BYTES, relayActionSchema } from '@blockwarden/core'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { getTx, relay, RelayerApiError, type RelayerClientOptions } from '@blockwarden/relayer-client'
import {
  concat,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseEventLogs,
  recoverTypedDataAddress,
  size,
  toFunctionSelector,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiHandler } from '../../src/api.js'
import { processRecords } from '../../src/batch.js'
import { createRelayerChain, type RelayerChain } from '../../src/chain.js'
import { sqsTxQueue, type TxQueue } from '../../src/queue.js'
import { processTx, type SignerDeps } from '../../src/signer.js'
import { RelayerStore } from '../../src/store.js'
import { hashApiKey } from '../../src/submit.js'
import { sweepChain } from '../../src/sweeper.js'
import { startAnvil, type Anvil } from '../helpers/anvil.js'
import { localAccount, signerRecord } from '../helpers/fixtures.js'
import { serveApi } from '../helpers/http.js'
import { startMoto, type Moto } from '../helpers/moto.js'

const API_KEY = 'bw_demo_key'
const SIGNER_ID = 'demo'
const ETH = 10n ** 18n
const FORWARDED_GAS = 100_000n
// how long a signed forward request stays valid; unrelated to the vault's cooldown
const REQUEST_VALID_FOR_SECONDS = 3600

// relayer-client -> HTTP -> API handler -> DynamoDB Local + SQS FIFO on moto -> signer -> Anvil -> sweeper, with
// the demo contracts deployed through the same CREATE2 path as script/Deploy.s.sol
describe('the relayer against the demo contracts', () => {
  let anvil: Anvil
  let dynamo: Dynamo
  let moto: Moto
  let demo: Demo
  let chain: RelayerChain
  let store: RelayerStore
  let queueUrl: string
  let queue: TxQueue
  let relayer: LocalAccount
  let signerDeps: SignerDeps
  let api: { url: string; close(): Promise<void> }
  let client: RelayerClientOptions

  beforeAll(async () => {
    ;[anvil, dynamo, moto] = await Promise.all([startAnvil(), startDynamo(), startMoto()])
    demo = await deployDemo(anvil.rpcUrl)
    const { forwarder, vault } = demo.addresses
    const owner = createWalletClient({
      account: privateKeyToAccount(ANVIL_OWNER_KEY),
      chain: foundry,
      transport: http(anvil.rpcUrl),
    })
    // two top-ups' worth: one through the forwarder, one the way a rule's relay action sends it
    const funded = await owner.writeContract({
      address: vault,
      abi: demo.abis.vault,
      functionName: 'fund',
      args: [2n * demo.params.topUpAmount],
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: funded })

    chain = createRelayerChain(anvil.chainId, [anvil.rpcUrl])
    store = new RelayerStore(dynamo.doc, await dynamo.newTable())
    queueUrl = await moto.newFifoQueue()
    queue = sqsTxQueue(moto.sqs, queueUrl)
    relayer = await localAccount(generatePrivateKey())
    await anvil.setBalance(relayer.address, 10n * ETH)
    await store.putSigner(
      signerRecord({
        signerId: SIGNER_ID,
        chainIds: [anvil.chainId],
        policy: {
          ...signerRecord().policy,
          // the policy sees only the outer target and selector: the forwarder's execute admits a request to any contract that trusts the forwarder, and topUp is admitted only on the vault
          allowedTo: [
            {
              address: forwarder,
              selectors: [toFunctionSelector('execute((address,address,uint256,uint256,uint48,bytes,bytes))')],
            },
            { address: vault, selectors: [toFunctionSelector('topUp(address)')] },
          ],
          dailySpendCapWei: String(5n * ETH),
        },
      }),
    )
    await store.putApiKey({ hash: hashApiKey(API_KEY), signerIds: [SIGNER_ID], label: 'demo', createdAt: 'x' })
    const chainFor = (chainId: number) => (chainId === anvil.chainId ? chain : undefined)
    signerDeps = {
      store,
      chainFor,
      accountFor: async () => relayer,
      queue,
      now: () => new Date(),
      newTxId: () => crypto.randomUUID(),
      reconciled: new Set(),
      log: () => {},
    }
    api = await serveApi(
      createApiHandler({
        store,
        chainFor,
        addressFor: async () => relayer.address,
        queue,
        now: () => new Date(),
        newTxId: () => crypto.randomUUID(),
        log: () => {},
      }),
    )
    client = { baseUrl: api.url, apiKey: API_KEY }
  })

  afterAll(async () => {
    await api?.close()
    await Promise.all([anvil?.stop(), dynamo?.stop(), moto?.stop()])
  })

  const drain = () =>
    moto.drain(queueUrl, (records) =>
      processRecords(
        records,
        (txId) => processTx(signerDeps, txId),
        () => {},
      ),
    )
  const sweep = () =>
    sweepChain(
      {
        store,
        chain,
        settings: { chainId: anvil.chainId, confirmations: 5, stuckAfterMs: 90_000 },
        accountFor: async () => relayer,
        queue,
        now: () => new Date(),
        requeueAfterMs: 600_000,
        newTxId: () => crypto.randomUUID(),
        log: () => {},
      },
      Date.now() + 30_000,
    )
  // submitted, mined, then confirmed five blocks deep, as the relayer end-to-end test drives it
  const confirm = async (txId: string) => {
    await drain()
    expect(await sweep()).toMatchObject({ mined: 1 })
    await anvil.mine(4)
    expect(await sweep()).toMatchObject({ confirmed: 1 })
    return getTx(client, txId)
  }
  const toppedUpIn = async (hash: Hex) => {
    const receipt = await anvil.publicClient.getTransactionReceipt({ hash })
    // the event's topic alone would match any contract emitting the same signature
    const fromVault = receipt.logs.filter((log) => log.address.toLowerCase() === demo.addresses.vault.toLowerCase())
    return parseEventLogs({ abi: demo.abis.vault, logs: fromVault, eventName: 'ToppedUp' }).map((log) => log.args)
  }
  const balanceOf = (account: Address) =>
    anvil.publicClient.readContract({
      address: demo.addresses.vault,
      abi: demo.abis.vault,
      functionName: 'balanceOf',
      args: [account],
    })

  it('relays a signed forward request to confirmed, attributed to its signer, and refuses it a second time', async () => {
    const { forwarder, vault } = demo.addresses
    // generated here and never funded: the relayer pays the gas, the request signer only signs
    const requester = privateKeyToAccount(generatePrivateKey())
    const nonce = (await anvil.publicClient.readContract({
      address: forwarder,
      abi: demo.abis.forwarder,
      functionName: 'nonces',
      args: [requester.address],
    })) as bigint
    const { timestamp } = await anvil.publicClient.getBlock()
    const request = await signForwardRequest(
      requester,
      { chainId: anvil.chainId, forwarder },
      {
        to: vault,
        data: encodeFunctionData({ abi: demo.abis.vault, functionName: 'topUp', args: [requester.address] }),
        gas: FORWARDED_GAS,
        deadline: Number(timestamp) + REQUEST_VALID_FOR_SECONDS,
        nonce,
      },
    )
    const execute = encodeFunctionData({ abi: demo.abis.forwarder, functionName: 'execute', args: [request] })

    const queued = await relay(client, {
      signerId: SIGNER_ID,
      chainId: anvil.chainId,
      to: forwarder,
      data: execute,
      idempotencyKey: 'meta-top-up',
    })
    const confirmed = await confirm(queued.txId)
    expect(confirmed).toMatchObject({ status: 'confirmed', receiptStatus: 'success', from: relayer.address })
    expect(await toppedUpIn(confirmed.hash!)).toEqual([
      { account: requester.address, by: requester.address, amount: demo.params.topUpAmount },
    ])
    expect(await balanceOf(requester.address)).toBe(demo.params.topUpAmount)

    const noncePending = () => anvil.publicClient.getTransactionCount({ address: relayer.address, blockTag: 'pending' })
    const relayerNonce = await noncePending()
    // a new idempotency key, so the relayer treats it as a new request rather than returning the first one
    const replay = await relay(client, {
      signerId: SIGNER_ID,
      chainId: anvil.chainId,
      to: forwarder,
      data: execute,
      idempotencyKey: 'meta-top-up-again',
    }).catch((err: unknown) => err)
    expect(replay).toBeInstanceOf(RelayerApiError)
    const refused = replay as RelayerApiError
    expect(refused).toMatchObject({ status: 422, code: 'estimate_reverted' })
    // the signature was over nonce 0; checked against nonce 1 it recovers to an unrelated address
    const recovered = await recoverTypedDataAddress({
      domain: { name: FORWARDER_NAME, version: '1', chainId: anvil.chainId, verifyingContract: forwarder },
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: {
        from: request.from,
        to: request.to,
        value: request.value,
        gas: request.gas,
        nonce: nonce + 1n,
        deadline: request.deadline,
        data: request.data,
      },
      signature: request.signature,
    })
    expect(decodeErrorResult({ abi: demo.abis.forwarder, data: refused.revertData! })).toMatchObject({
      errorName: 'ERC2771ForwarderInvalidSigner',
      args: [recovered, requester.address],
    })
    // refused at the estimate: no record for the key, and the relayer's account nonce did not move
    expect(await store.getIdempotency(hashApiKey(API_KEY), 'meta-top-up-again')).toBeUndefined()
    expect(await noncePending()).toBe(relayerNonce)
    expect(await balanceOf(requester.address)).toBe(demo.params.topUpAmount)
  })

  it('carries the fixed topUp call a rule relays, within the schema cap, and relays it as the signer', async () => {
    const demoAccount = privateKeyToAccount(generatePrivateKey()).address
    const raw = {
      type: 'relay',
      signerId: SIGNER_ID,
      chainId: anvil.chainId,
      to: demo.addresses.vault,
      data: encodeFunctionData({ abi: demo.abis.vault, functionName: 'topUp', args: [demoAccount] }),
    }
    const action = relayActionSchema.parse(raw)
    expect(size(action.data)).toBeLessThanOrEqual(MAX_RELAY_DATA_BYTES)
    // the cap is live: the same call padded one byte past it is refused
    const padded = concat([action.data, `0x${'00'.repeat(MAX_RELAY_DATA_BYTES - size(action.data) + 1)}`])
    expect(relayActionSchema.safeParse({ ...raw, data: padded }).success).toBe(false)

    const queued = await relay(client, {
      signerId: action.signerId,
      chainId: action.chainId,
      to: action.to,
      data: action.data,
      idempotencyKey: 'rule-top-up',
    })
    const confirmed = await confirm(queued.txId)
    expect(confirmed).toMatchObject({ status: 'confirmed', receiptStatus: 'success' })
    // a direct call, so the vault names the relayer's own address as the one who topped up
    expect(await toppedUpIn(confirmed.hash!)).toEqual([
      { account: demoAccount, by: relayer.address, amount: demo.params.topUpAmount },
    ])

    // the same fixed call fires again inside the cooldown: refused before it reaches the queue
    const again = await relay(client, {
      signerId: action.signerId,
      chainId: action.chainId,
      to: action.to,
      data: action.data,
      idempotencyKey: 'rule-top-up-again',
    }).catch((err: unknown) => err)
    expect(again).toMatchObject({ status: 422, code: 'estimate_reverted' })
    const lastTopUp = (await anvil.publicClient.readContract({
      address: demo.addresses.vault,
      abi: demo.abis.vault,
      functionName: 'lastTopUp',
      args: [demoAccount],
    })) as bigint
    expect(decodeErrorResult({ abi: demo.abis.vault, data: (again as RelayerApiError).revertData! })).toMatchObject({
      errorName: 'CooldownActive',
      args: [demoAccount, lastTopUp + demo.params.cooldown],
    })
  })
})
