import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { createPublicClient, http, type Address } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CREATE2_FACTORY,
  DEFAULT_VAULT,
  defaultVaultParams,
  deployDemo,
  FORWARDER_NAME,
  loadArtifact,
  predictDemoAddresses,
} from '../ts/testing.js'

const contractsDir = fileURLToPath(new URL('..', import.meta.url))

async function startAnvil(chainId: number): Promise<{ container: StartedTestContainer; rpcUrl: string }> {
  const container = await new GenericContainer('ghcr.io/foundry-rs/foundry:v1.8.1')
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([`anvil --host 0.0.0.0 --chain-id ${chainId}`])
    .withExposedPorts(8545)
    .withWaitStrategy(Wait.forLogMessage(/Listening on/))
    .start()
  return { container, rpcUrl: `http://${container.getHost()}:${container.getMappedPort(8545)}` }
}

// the package scripts themselves, so the test runs what an operator runs
function runPackageScript(name: 'deploy' | 'fund', rpcUrl: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['scripts/local.mjs', name], {
    cwd: contractsDir,
    env: { ...process.env, ...env, RPC_URL: rpcUrl },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${name} failed:\n${result.stdout}\n${result.stderr}`)
}

type DeploymentFile = {
  chainId: number
  forwarderName: string
  forwarder: Address
  emitter: Address
  vault: Address
  owner: Address
  threshold: string
  topUpAmount: string
  cooldown: string
}

const deploymentUrl = (chainId: number) => new URL(`../deployments/${chainId}.json`, import.meta.url)

function readDeployment(chainId: number): DeploymentFile {
  return JSON.parse(readFileSync(deploymentUrl(chainId), 'utf8')) as DeploymentFile
}

describe('the CREATE2 deployment', () => {
  let local: Awaited<ReturnType<typeof startAnvil>>
  let other: Awaited<ReturnType<typeof startAnvil>>

  beforeAll(async () => {
    // a file left by an earlier run would satisfy the comparison without the script having run
    rmSync(deploymentUrl(31337), { force: true })
    ;[local, other] = await Promise.all([startAnvil(31337), startAnvil(84532)])
  })

  afterAll(async () => {
    await Promise.all([local?.container.stop(), other?.container.stop()])
  })

  const code = (rpcUrl: string, address: Address) =>
    createPublicClient({ transport: http(rpcUrl) }).getCode({ address })
  const pool = (rpcUrl: string, vault: Address) =>
    createPublicClient({ transport: http(rpcUrl) }).readContract({
      address: vault,
      abi: loadArtifact('TopUpVault').abi,
      functionName: 'pool',
    })

  it('finds the deterministic deployer Anvil puts at genesis', async () => {
    expect(await code(local.rpcUrl, CREATE2_FACTORY)).toBeDefined()
    expect(await code(other.rpcUrl, CREATE2_FACTORY)).toBeDefined()
  })

  it('deploys through forge script to the addresses the TypeScript path predicts', async () => {
    runPackageScript('deploy', local.rpcUrl)
    const written = readDeployment(31337)
    const predicted = predictDemoAddresses()
    expect(written).toEqual({
      chainId: 31337,
      forwarderName: FORWARDER_NAME,
      forwarder: predicted.forwarder,
      emitter: predicted.emitter,
      vault: predicted.vault,
      owner: defaultVaultParams().owner,
      threshold: String(DEFAULT_VAULT.threshold),
      topUpAmount: String(DEFAULT_VAULT.topUpAmount),
      cooldown: String(DEFAULT_VAULT.cooldown),
    })
    for (const address of [written.forwarder, written.emitter, written.vault]) {
      expect(await code(local.rpcUrl, address)).toBeDefined()
    }
  })

  it('lands the TypeScript deployment on another chain id at the addresses the script wrote', async () => {
    const written = readDeployment(31337)
    const demo = await deployDemo(other.rpcUrl)
    expect(demo.addresses).toEqual({ forwarder: written.forwarder, emitter: written.emitter, vault: written.vault })
    expect(demo.addresses).toEqual(predictDemoAddresses())
    for (const address of Object.values(demo.addresses)) expect(await code(other.rpcUrl, address)).toBeDefined()
  })

  it('funds only in the separate step, and a second deploy neither fails nor refunds', async () => {
    const { vault } = predictDemoAddresses()
    expect(await pool(local.rpcUrl, vault)).toBe(0n)
    runPackageScript('fund', local.rpcUrl, { FUND_AMOUNT: '1000' })
    expect(await pool(local.rpcUrl, vault)).toBe(1000n)
    runPackageScript('deploy', local.rpcUrl)
    expect(await pool(local.rpcUrl, vault)).toBe(1000n)
  })
})
