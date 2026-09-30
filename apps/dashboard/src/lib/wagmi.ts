import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { parseChainIds } from './chains'

// The static export has no server, so the chain list is fixed at build time. It must be a subset of the API's
// CHAINS: the API refuses a SIWE message that names a chain it does not monitor.
// The literal process.env.NEXT_PUBLIC_* form is what Next inlines into the bundle.
export const chains = parseChainIds(process.env.NEXT_PUBLIC_CHAIN_IDS)

// http() with no URL and no chain-reading hooks anywhere in the app: only the wallet talks to a chain. A
// browser-side RPC would need a key in a public bundle and a wider connect-src in the CSP.
export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((chain) => [chain.id, http()])),
  ssr: true,
})
