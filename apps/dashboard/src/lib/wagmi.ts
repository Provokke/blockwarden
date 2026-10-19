import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { chains } from './chains'

// http() with no URL and no chain-reading hooks anywhere in the app: only the wallet talks to a chain. A
// browser-side RPC would need a key in a public bundle and a wider connect-src in the CSP.
export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((chain) => [chain.id, http()])),
  ssr: true,
})
