import { readFileSync } from 'node:fs'
import solc from 'solc'
import { GenericContainer, Wait } from 'testcontainers'
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

export const PING_EVENT = 'event Ping(address indexed from, uint256 value)'

// Anvil's first default account; it only exists on the local test chain.
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function compileEmitter(): { abi: Abi; bytecode: Hex } {
  const content = readFileSync(new URL('../fixtures/DemoEmitter.sol', import.meta.url), 'utf8')
  const input = {
    language: 'Solidity',
    sources: { 'DemoEmitter.sol': { content } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length > 0) throw new Error(JSON.stringify(errors))
  const contract = output.contracts['DemoEmitter.sol'].DemoEmitter
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
  const account = privateKeyToAccount(ANVIL_KEY)
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 100 })
  const wallet = createWalletClient({ account, chain: foundry, transport })
  const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport })
  const { abi, bytecode } = compileEmitter()

  return {
    rpcUrl,
    chainId: foundry.id,
    sender: account.address,
    async deployEmitter(): Promise<Hex> {
      const hash = await wallet.deployContract({ abi, bytecode })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (!receipt.contractAddress) throw new Error('DemoEmitter deploy returned no address')
      return receipt.contractAddress
    },
    async ping(emitter: Hex, value: bigint): Promise<{ blockNumber: number; blockHash: Hex }> {
      const hash = await wallet.writeContract({ address: emitter, abi, functionName: 'ping', args: [value] })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      return { blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash }
    },
    async mine(blocks: number): Promise<void> {
      await testClient.mine({ blocks })
    },
    async reorg(depth: number): Promise<void> {
      await testClient.request({ method: 'anvil_reorg' as never, params: [depth, []] as never })
    },
    async stop(): Promise<void> {
      await container.stop()
    },
  }
}
