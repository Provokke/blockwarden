import { createServer } from 'node:http'
import { Metrics } from '@aws-lambda-powertools/metrics'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import type { Hex, LocalAccount } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RelayerChain } from '../../src/chain.js'
import { createLogger, createRuntime } from '../../src/lambda/runtime.js'
import { createSweeperHandler } from '../../src/lambda/sweeper.js'
import type { SignerRecord } from '../../src/records.js'
import { RelayerStore } from '../../src/store.js'
import { startAnvil, type Anvil } from '../helpers/anvil.js'
import { FakeChain } from '../helpers/fake-chain.js'
import { localAccount, queuedTx, signerRecord } from '../helpers/fixtures.js'

// what a provider API key looks like in an RPC URL; it must never reach a log or the error the runtime logs
const URL_KEY = 'k3y-4f9c2e7a1b'

// the Lambda wiring: configuration from the environment, the runtime it builds, and the metrics it publishes
describe('sweeper Lambda entry', () => {
  let anvil: Anvil
  let dynamo: Dynamo
  let output: string[]

  beforeAll(async () => {
    ;[anvil, dynamo] = await Promise.all([startAnvil(), startDynamo()])
  })

  afterAll(async () => {
    await Promise.all([anvil?.stop(), dynamo?.stop()])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const lines = () => output.flatMap((chunk) => chunk.split('\n')).filter((line) => line.startsWith('{'))

  const emf = () =>
    lines()
      .filter((line) => line.includes('"_aws"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  const logEntries = () =>
    lines()
      .filter((line) => !line.includes('"_aws"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  const stubEnv = (tableName: string, chains: unknown[], signerIds?: string) => {
    vi.stubEnv('TABLE_NAME', tableName)
    vi.stubEnv('DYNAMODB_ENDPOINT', dynamo.endpoint)
    vi.stubEnv('AWS_REGION', 'us-east-1')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local')
    if (signerIds !== undefined) vi.stubEnv('SIGNER_IDS', signerIds)
    vi.stubEnv('CHAINS', JSON.stringify(chains))
  }

  const captureOutput = () => {
    output = []
    // Powertools writes metrics and info logs to stdout and error logs to stderr
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk))
        return true
      })
    }
  }

  const sweeper = (
    name: string,
    overrides: {
      accountFor?: (signer: SignerRecord) => Promise<LocalAccount>
      chains?: Map<number, RelayerChain>
    },
  ) => {
    const logger = createLogger(name)
    return createSweeperHandler(
      async () => ({ ...(await createRuntime(logger, 'sweeper')), ...overrides }),
      logger,
      new Metrics({ namespace: 'Blockwarden', serviceName: 'relayer' }),
    )
  }

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (err: unknown) => err as Error,
    )

  const spend = { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }

  it('sweeps every chain, publishes pending age and signer balance, and fails after a chain whose RPC is down', async () => {
    const tableName = await dynamo.newTable()
    const store = new RelayerStore(dynamo.doc, tableName)
    const account = await localAccount()
    await anvil.setBalance(account.address, 3n * 10n ** 18n)
    await store.putSigner(signerRecord({ chainIds: [anvil.chainId, 999] }))
    // a pending transaction on the dead chain makes its sweep call the RPC
    const stuck = queuedTx(account.address, { chainId: 999, status: 'submitted', nonce: 0 })
    await store.createTx(stuck, spend, Date.now())

    // the dead chain comes first, so the test shows the healthy one is still swept after it fails
    stubEnv(
      tableName,
      [
        { chainId: 999, rpcUrls: [`http://127.0.0.1:9/v2/${URL_KEY}`] },
        { chainId: anvil.chainId, rpcUrls: [anvil.rpcUrl] },
      ],
      'billing',
    )
    captureOutput()

    const handler = sweeper('test-sweeper', { accountFor: async () => account })
    const err = await rejection(handler(undefined, { getRemainingTimeInMillis: () => 60_000 }))

    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('chain 999')
    // the runtime logs a rejection's message and stack, and may serialise its cause
    expect(err?.cause).toBeUndefined()
    for (const text of [err?.message, err?.stack, output.join('')]) {
      expect(text).not.toContain('127.0.0.1:9')
      expect(text).not.toContain(URL_KEY)
    }

    const metrics = emf()
    expect(metrics).toContainEqual(
      expect.objectContaining({ service: 'relayer', chainId: String(anvil.chainId), pendingAgeSeconds: 0 }),
    )
    expect(metrics).toContainEqual(
      expect.objectContaining({
        chainId: String(anvil.chainId),
        signerId: 'billing',
        signerBalanceGwei: 3_000_000_000,
      }),
    )
    // the failed chain published nothing
    expect(metrics.filter((m) => m.chainId === '999')).toEqual([])
    expect(logEntries()).toContainEqual(
      expect.objectContaining({ level: 'ERROR', message: 'sweep failed', chainId: 999 }),
    )
  })

  it('finishes every chain, then rejects, when a swept chain leaves per-transaction errors', async () => {
    const tableName = await dynamo.newTable()
    const store = new RelayerStore(dynamo.doc, tableName)
    const account = await localAccount()
    await store.putSigner(signerRecord({ chainIds: [222, 111] }))

    const attempt = (hash: Hex) => ({
      hash,
      raw: '0x' as Hex,
      maxFeePerGas: '1',
      maxPriorityFeePerGas: '1',
      signedAt: Date.now(),
    })

    // errors first, so the test shows the chain after it still gets swept
    const failingHash: Hex = '0xaa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa1'
    const failing = queuedTx(account.address, {
      chainId: 222,
      status: 'submitted',
      nonce: 0,
      attempts: [attempt(failingHash)],
    })
    await store.createTx(failing, spend, Date.now())

    const healthyHash: Hex = '0xbb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb2'
    const healthy = queuedTx(account.address, {
      chainId: 111,
      status: 'submitted',
      nonce: 0,
      attempts: [attempt(healthyHash)],
    })
    await store.createTx(healthy, spend, Date.now())

    const failingChain = new FakeChain(222)
    failingChain.getReceipt = async () => {
      throw new Error('boom')
    }
    const healthyChain = new FakeChain(111)
    healthyChain.mine(healthyHash)

    stubEnv(tableName, [
      { chainId: 222, rpcUrls: ['http://x'] },
      { chainId: 111, rpcUrls: ['http://x'] },
    ])
    captureOutput()

    const handler = sweeper('test-sweeper-errors', {
      accountFor: async () => account,
      chains: new Map([
        [222, failingChain],
        [111, healthyChain],
      ]),
    })
    const err = await rejection(handler(undefined, { getRemainingTimeInMillis: () => 60_000 }))

    expect(err?.message).toContain('sweep left transaction errors on chains 222')
    expect(logEntries()).toContainEqual(
      expect.objectContaining({ level: 'ERROR', message: 'sweep left transaction errors', chainIds: [222] }),
    )
    // the healthy chain was still swept, despite the earlier chain's per-transaction error
    expect((await store.getTx(healthy.txId))?.status).toBe('mined')
  })

  it('gives up on a chain whose RPC never answers before the Lambda times out, and still reports the others', async () => {
    // accepts the connection and never answers, as a hung provider does
    const hung = createServer(() => {})
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve))
    const port = (hung.address() as { port: number }).port
    try {
      const tableName = await dynamo.newTable()
      const store = new RelayerStore(dynamo.doc, tableName)
      const account = await localAccount()
      await anvil.setBalance(account.address, 2n * 10n ** 18n)
      await store.putSigner(signerRecord({ chainIds: [5555, anvil.chainId] }))
      await store.createTx(
        queuedTx(account.address, { chainId: 5555, status: 'submitted', nonce: 0 }),
        spend,
        Date.now(),
      )

      stubEnv(
        tableName,
        [
          { chainId: 5555, rpcUrls: [`http://127.0.0.1:${port}/v2/${URL_KEY}`] },
          { chainId: anvil.chainId, rpcUrls: [anvil.rpcUrl] },
        ],
        'billing',
      )
      captureOutput()

      const handler = sweeper('test-sweeper-hung', { accountFor: async () => account })
      // 9 seconds left: the sweeps stop starting transactions after 1, and what is still running is abandoned
      // after 6, well inside the 10 second RPC timeout
      const started = Date.now()
      const err = await rejection(handler(undefined, { getRemainingTimeInMillis: () => 9_000 }))
      const elapsed = Date.now() - started

      expect(elapsed).toBeLessThan(6_000 + 1_500)
      expect(err?.message).toContain('chain 5555 did not finish before the deadline')
      const metrics = emf()
      expect(metrics).toContainEqual(expect.objectContaining({ chainId: String(anvil.chainId), pendingAgeSeconds: 0 }))
      expect(metrics).toContainEqual(
        expect.objectContaining({
          chainId: String(anvil.chainId),
          signerId: 'billing',
          signerBalanceGwei: 2_000_000_000,
        }),
      )
      expect(output.join('')).not.toContain(URL_KEY)
    } finally {
      hung.closeAllConnections()
      await new Promise((resolve) => hung.close(resolve))
    }
  })

  it('fails when a reported signer has no item, or lists a chain this sweeper does not sweep', async () => {
    const tableName = await dynamo.newTable()
    const store = new RelayerStore(dynamo.doc, tableName)
    const account = await localAccount()
    // billing is on one of the two chains only, which is ordinary and no error
    await store.putSigner(signerRecord({ signerId: 'billing', chainIds: [111] }))
    await store.putSigner(signerRecord({ signerId: 'stray', chainIds: [111, 777] }))

    const chain111 = new FakeChain(111)
    chain111.balances.set(account.address.toLowerCase(), 5n * 10n ** 9n)
    stubEnv(
      tableName,
      [
        { chainId: 111, rpcUrls: ['http://x'] },
        { chainId: 222, rpcUrls: ['http://x'] },
      ],
      'billing,ghost,stray',
    )
    captureOutput()

    const handler = sweeper('test-sweeper-signers', {
      accountFor: async () => account,
      chains: new Map([
        [111, chain111],
        [222, new FakeChain(222)],
      ]),
    })
    const err = await rejection(handler(undefined, { getRemainingTimeInMillis: () => 60_000 }))

    expect(err?.message).toContain('ghost')
    expect(err?.message).toContain('stray')
    expect(err?.message).not.toContain('billing')
    const errors = logEntries().filter((entry) => entry.level === 'ERROR')
    expect(errors).toContainEqual(expect.objectContaining({ signerId: 'ghost' }))
    expect(errors).toContainEqual(expect.objectContaining({ signerId: 'stray', chainIds: [777] }))
    expect(errors.filter((entry) => entry.signerId === 'billing')).toEqual([])
    // the signers that exist still have their balances reported
    const metrics = emf()
    expect(metrics).toContainEqual(
      expect.objectContaining({ chainId: '111', signerId: 'billing', signerBalanceGwei: 5 }),
    )
    expect(metrics).toContainEqual(expect.objectContaining({ chainId: '111', signerId: 'stray', signerBalanceGwei: 5 }))
  })

  it('logs a failed balance read as such, reports the remaining signers, and fails the invocation', async () => {
    const tableName = await dynamo.newTable()
    const store = new RelayerStore(dynamo.doc, tableName)
    const account = await localAccount()
    await store.putSigner(signerRecord({ signerId: 'billing', keyId: 'denied', chainIds: [111] }))
    await store.putSigner(signerRecord({ signerId: 'second', chainIds: [111] }))

    const chain111 = new FakeChain(111)
    chain111.balances.set(account.address.toLowerCase(), 7n * 10n ** 9n)
    stubEnv(tableName, [{ chainId: 111, rpcUrls: ['http://x'] }], 'billing,second')
    captureOutput()

    const handler = sweeper('test-sweeper-balance', {
      accountFor: async (signer) => {
        if (signer.keyId === 'denied') throw new Error('kms access denied')
        return account
      },
      chains: new Map([[111, chain111]]),
    })
    const err = await rejection(handler(undefined, { getRemainingTimeInMillis: () => 60_000 }))

    expect(err?.message).toContain('balance read failed on chain 111 for signer billing')
    const entries = logEntries()
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: 'balance read failed',
        chainId: 111,
        signerId: 'billing',
        error: 'kms access denied',
      }),
    )
    expect(entries.filter((entry) => entry.message === 'sweep failed')).toEqual([])
    const metrics = emf()
    expect(metrics).toContainEqual(expect.objectContaining({ chainId: '111', pendingAgeSeconds: 0 }))
    expect(metrics).toContainEqual(
      expect.objectContaining({ chainId: '111', signerId: 'second', signerBalanceGwei: 7 }),
    )
  })
})
