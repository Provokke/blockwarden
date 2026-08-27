import { Metrics } from '@aws-lambda-powertools/metrics'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLogger, createRuntime } from '../../src/lambda/runtime.js'
import { createSweeperHandler } from '../../src/lambda/sweeper.js'
import { RelayerStore } from '../../src/store.js'
import { startAnvil, type Anvil } from '../helpers/anvil.js'
import { localAccount, queuedTx, signerRecord } from '../helpers/fixtures.js'

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

  const emf = () =>
    output
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.includes('"_aws"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  it('sweeps every chain, publishes pending age and signer balance, and fails after a chain whose RPC is down', async () => {
    const tableName = await dynamo.newTable()
    const store = new RelayerStore(dynamo.doc, tableName)
    const account = await localAccount()
    await anvil.setBalance(account.address, 3n * 10n ** 18n)
    await store.putSigner(signerRecord({ chainIds: [anvil.chainId, 999] }))
    // a pending transaction on the dead chain makes its sweep call the RPC
    const stuck = queuedTx(account.address, { chainId: 999, status: 'submitted', nonce: 0 })
    await store.createTx(stuck, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, Date.now())

    vi.stubEnv('TABLE_NAME', tableName)
    vi.stubEnv('DYNAMODB_ENDPOINT', dynamo.endpoint)
    vi.stubEnv('AWS_REGION', 'us-east-1')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local')
    vi.stubEnv('SIGNER_IDS', 'billing')
    // the dead chain comes first, so the test shows the healthy one is still swept after it fails
    vi.stubEnv(
      'CHAINS',
      JSON.stringify([
        { chainId: 999, rpcUrls: ['http://127.0.0.1:9'] },
        { chainId: anvil.chainId, rpcUrls: [anvil.rpcUrl] },
      ]),
    )
    output = []
    // Powertools writes metrics and info logs to stdout and error logs to stderr
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk))
        return true
      })
    }

    const logger = createLogger('test-sweeper')
    const handler = createSweeperHandler(
      async () => ({ ...(await createRuntime(logger)), accountFor: async () => account }),
      logger,
      new Metrics({ namespace: 'Blockwarden', serviceName: 'relayer' }),
    )
    await expect(handler(undefined, { getRemainingTimeInMillis: () => 60_000 })).rejects.toThrow()

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
    expect(output.join('')).toContain('sweep failed')
  })
})
