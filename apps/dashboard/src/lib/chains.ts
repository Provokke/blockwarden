import { arbitrum, base, baseSepolia, mainnet, optimism, polygon, sepolia } from 'viem/chains'
import type { Chain } from 'viem'

const KNOWN: Record<number, Chain> = Object.fromEntries(
  [mainnet, base, arbitrum, optimism, polygon, sepolia, baseSepolia].map((chain) => [chain.id, chain]),
)

const DEFAULT_CHAIN_IDS = '1,8453,42161'

// A dropped id would leave a wallet on a chain the deployment monitors unable to sign in, and nothing would
// say why, so anything that is not a known chain id stops the build.
export function parseChainIds(raw: string | undefined = DEFAULT_CHAIN_IDS): readonly [Chain, ...Chain[]] {
  const chains: Chain[] = []
  for (const part of raw.split(',')) {
    const text = part.trim()
    const chain = /^[1-9][0-9]*$/.test(text) ? KNOWN[Number(text)] : undefined
    if (!chain) throw new Error(`NEXT_PUBLIC_CHAIN_IDS: ${JSON.stringify(text)} is not a supported chain id`)
    if (chains.some((c) => c.id === chain.id)) throw new Error(`NEXT_PUBLIC_CHAIN_IDS lists ${chain.id} twice`)
    chains.push(chain)
  }
  return chains as unknown as readonly [Chain, ...Chain[]]
}
