import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Nav } from '../components/Nav'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Blockwarden',
  description: 'Monitoring and relaying for your contracts',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
