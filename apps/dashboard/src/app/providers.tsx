'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '../lib/wagmi'

export function Providers({ children }: { children: ReactNode }) {
  // in state so a re-render keeps the cache instead of building a new one
  const [queryClient] = useState(
    () =>
      // a refused request is shown with a Retry button; retrying it silently behind a spinner would hide a 4xx the
      // operator has to act on
      new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
  )
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
