import { readFileSync } from 'node:fs'
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

// Every value below mirrors script/DemoConfig.sol; test-ts/deploy.test.ts deploys through both and fails if the
// addresses differ, which is the only thing that would show the two drifting apart.
export const CREATE2_FACTORY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
export const FORWARDER_NAME = 'BlockwardenForwarder'
export const SALTS = {
  forwarder: keccak256(stringToHex('blockwarden.demo.forwarder')),
  emitter: keccak256(stringToHex('blockwarden.demo.emitter')),
  vault: keccak256(stringToHex('blockwarden.demo.vault')),
} as const
export const DEFAULT_VAULT = { threshold: 100n, topUpAmount: 500n, cooldown: 3600n } as const

// Anvil's first default account; it only exists on a local test chain. It deploys, and it owns the vault.
export const ANVIL_OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

export type ContractName = 'ERC2771Forwarder' | 'DemoEmitter' | 'TopUpVault'
export type Artifact = { abi: Abi; bytecode: Hex }
export type VaultParams = { owner: Address; threshold: bigint; topUpAmount: bigint; cooldown: bigint }
export type DemoAddresses = { forwarder: Address; emitter: Address; vault: Address }
export type Demo = {
  addresses: DemoAddresses
  params: VaultParams
  abis: { forwarder: Abi; emitter: Abi; vault: Abi }
}

export function loadArtifact(name: ContractName): Artifact {
  const url = new URL(`../out/${name}.sol/${name}.json`, import.meta.url)
  let text: string
  try {
    text = readFileSync(url, 'utf8')
  } catch (err) {
    throw new Error(`no forge artifact for ${name}; run pnpm --filter @blockwarden/contracts run build first`, {
      cause: err,
    })
  }
  const artifact = JSON.parse(text) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: artifact.abi, bytecode: artifact.bytecode.object }
}

export function defaultVaultParams(): VaultParams {
  return { owner: privateKeyToAccount(ANVIL_OWNER_KEY).address, ...DEFAULT_VAULT }
}

function initCodes(params: VaultParams): {
  forwarder: Hex
  emitter: (forwarder: Address) => Hex
  vault: (forwarder: Address) => Hex
} {
  const forwarder = loadArtifact('ERC2771Forwarder')
  const emitter = loadArtifact('DemoEmitter')
  const vault = loadArtifact('TopUpVault')
  return {
    forwarder: encodeDeployData({ abi: forwarder.abi, bytecode: forwarder.bytecode, args: [FORWARDER_NAME] }),
    emitter: (at) => encodeDeployData({ abi: emitter.abi, bytecode: emitter.bytecode, args: [at] }),
    vault: (at) =>
      encodeDeployData({
        abi: vault.abi,
        bytecode: vault.bytecode,
        args: [at, params.owner, params.threshold, params.topUpAmount, params.cooldown],
      }),
  }
}

function create2Address(salt: Hex, initCode: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_FACTORY, salt, bytecode: initCode })
}

export function predictDemoAddresses(params: VaultParams = defaultVaultParams()): DemoAddresses {
  const codes = initCodes(params)
  const forwarder = create2Address(SALTS.forwarder, codes.forwarder)
  return {
    forwarder,
    emitter: create2Address(SALTS.emitter, codes.emitter(forwarder)),
    vault: create2Address(SALTS.vault, codes.vault(forwarder)),
  }
}

// The transaction Deploy.s.sol sends for each contract: the salt followed by the init code, to the factory Anvil
// deploys at genesis. An address that already has code is left alone, as the script leaves it.
export async function deployDemo(
  rpcUrl: string,
  params: VaultParams = defaultVaultParams(),
  deployer: LocalAccount = privateKeyToAccount(ANVIL_OWNER_KEY),
): Promise<Demo> {
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ transport, cacheTime: 0, pollingInterval: 100 })
  // the node's own chain id, so an Anvil started with --chain-id is signed for correctly
  const chain = { ...foundry, id: await publicClient.getChainId() }
  const wallet = createWalletClient({ account: deployer, chain, transport })
  const codes = initCodes(params)
  const addresses = predictDemoAddresses(params)
  const steps: [Hex, Hex, Address][] = [
    [SALTS.forwarder, codes.forwarder, addresses.forwarder],
    [SALTS.emitter, codes.emitter(addresses.forwarder), addresses.emitter],
    [SALTS.vault, codes.vault(addresses.forwarder), addresses.vault],
  ]
  for (const [salt, initCode, expected] of steps) {
    if ((await publicClient.getCode({ address: expected })) !== undefined) continue
    const hash = await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concat([salt, initCode]) })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`the CREATE2 factory reverted deploying to ${expected}`)
    if ((await publicClient.getCode({ address: expected })) === undefined)
      throw new Error(`no code at ${expected} after deploying`)
  }
  return {
    addresses,
    params,
    abis: {
      forwarder: loadArtifact('ERC2771Forwarder').abi,
      emitter: loadArtifact('DemoEmitter').abi,
      vault: loadArtifact('TopUpVault').abi,
    },
  }
}

// EIP-712 types for OpenZeppelin 5.6.1's ERC2771Forwarder. The nonce is signed but is not a field of the request
// sent to execute, which reads it from the forwarder at execution time.
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const

export type ForwardRequestData = {
  from: Address
  to: Address
  value: bigint
  gas: bigint
  deadline: number
  data: Hex
  signature: Hex
}

export async function signForwardRequest(
  signer: LocalAccount,
  domain: { chainId: number; forwarder: Address },
  request: { to: Address; data: Hex; gas: bigint; deadline: number; nonce: bigint },
): Promise<ForwardRequestData> {
  const message = {
    from: signer.address,
    to: request.to,
    value: 0n,
    gas: request.gas,
    nonce: request.nonce,
    deadline: request.deadline,
    data: request.data,
  }
  const signature = await signer.signTypedData({
    domain: { name: FORWARDER_NAME, version: '1', chainId: domain.chainId, verifyingContract: domain.forwarder },
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message,
  })
  return {
    from: message.from,
    to: message.to,
    value: message.value,
    gas: message.gas,
    deadline: message.deadline,
    data: message.data,
    signature,
  }
}
