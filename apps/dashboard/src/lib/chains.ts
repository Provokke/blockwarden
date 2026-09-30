import { arbitrum, base, baseSepolia, mainnet, optimism, polygon, sepolia } from 'viem/chains'
import type { Chain } from 'viem'

const KNOWN: Record<number, Chain> = Object.fromEntries(
  [mainnet, base, arbitrum, optimism, polygon, sepolia, baseSepolia].map((chain) => [chain.id, chain]),
)

const DEFAULT_CHAIN_IDS = '1,8453,42161'

// A dropped id would leave a wallet on a monitored chain unable to sign in with no hint why, so
// anything that isn't a known chain id stops the build.
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

// The static export has no server, so the chain list is fixed at build time. It must be a subset of
// the API's CHAINS, which refuses a SIWE message naming a chain it doesn't monitor. The literal
// process.env.NEXT_PUBLIC_* form is what Next inlines.
export const chains = parseChainIds(process.env.NEXT_PUBLIC_CHAIN_IDS)

// a rule or signer may name a chain this build wasn't configured with; the id is still the truth
export function chainName(chainId: number): string {
  return chains.find((chain) => chain.id === chainId)?.name ?? String(chainId)
}
