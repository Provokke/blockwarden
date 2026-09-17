import { readFileSync } from 'node:fs'
import solc from 'solc'
import { GenericContainer, Wait } from 'testcontainers'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  numberToHex,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

export const TARGET_ABI = parseAbi([
  'function ping(uint256 value)',
  'function fail(uint256 code)',
  'function arm()',
  'function fire()',
  'error NotAllowed(uint256 code)',
  'error NotArmed()',
  'event Pinged(address indexed sender, uint256 value)',
])

// Anvil's first default account; it only exists on the local test chain.
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function compileTarget(): { abi: Abi; bytecode: Hex } {
  const content = readFileSync(new URL('../fixtures/Target.sol', import.meta.url), 'utf8')
  const input = {
    language: 'Solidity',
    sources: { 'Target.sol': { content } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length > 0) throw new Error(JSON.stringify(errors))
  const contract = output.contracts['Target.sol'].Target
  return { abi: contract.abi as Abi, bytecode: `0x${contract.evm.bytecode.object}` }
}

export type Anvil = Awaited<ReturnType<typeof startAnvil>>

export async function startAnvil() {
  const container = await new GenericContainer('ghcr.io/foundry-rs/foundry:v1.8.1')
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand(['anvil --host 0.0.0.0'])
    .withExposedPorts(8545)
    .withWaitStrategy(Wait.forLogMessage(/Listening on/))
    .start()
  const rpcUrl = `http://${container.getHost()}:${container.getMappedPort(8545)}`
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 100 })
  const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport })
  const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain: foundry, transport })
  const { abi, bytecode } = compileTarget()

  return {
    rpcUrl,
    chainId: foundry.id,
    publicClient,
    async deployTarget(): Promise<Address> {
      const hash = await deployer.deployContract({ abi, bytecode })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (!receipt.contractAddress) throw new Error('Target deploy returned no address')
      return receipt.contractAddress
    },
    async setBalance(address: Address, wei: bigint): Promise<void> {
      await testClient.setBalance({ address, value: wei })
    },
    // sends a plain transfer straight from a key, bypassing the relayer, to use up one of its nonces
    async sendExternal(privateKey: Hex): Promise<void> {
      const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: foundry, transport })
      const hash = await wallet.sendTransaction({ to: wallet.account.address, value: 0n })
      await publicClient.waitForTransactionReceipt({ hash })
    },
    async mine(blocks: number): Promise<void> {
      await testClient.mine({ blocks })
    },
    async setAutomine(enabled: boolean): Promise<void> {
      await testClient.setAutomine(enabled)
    },
    async dropTransaction(hash: Hex): Promise<void> {
      await testClient.dropTransaction({ hash })
    },
    // replaces the last depth blocks with empty ones; Anvil does not put their transactions back in the mempool
    async reorg(depth: number): Promise<void> {
      await testClient.request({ method: 'anvil_reorg' as never, params: [depth, []] as never })
    },
    async head(): Promise<number> {
      return Number(await publicClient.getBlockNumber())
    },
    hex: numberToHex,
    async stop(): Promise<void> {
      await container.stop()
    },
  }
}
