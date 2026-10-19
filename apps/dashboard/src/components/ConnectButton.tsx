'use client'

import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi'
import { chains } from '../lib/chains'

export function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function ConnectButton() {
  const { address, chainId, isConnected } = useConnection()
  const connectors = useConnectors()
  const { mutate: connect, error: connectError } = useConnect()
  const { mutate: disconnect } = useDisconnect()
  const { mutate: switchChain } = useSwitchChain()

  if (!isConnected || !address) {
    const wallet = connectors[0]
    return (
      <div>
        <button type="button" disabled={!wallet} onClick={() => wallet && connect({ connector: wallet })}>
          Connect wallet
        </button>
        {connectError ? <p role="alert">Could not connect: {connectError.message}</p> : null}
      </div>
    )
  }

  const supported = chainId !== undefined && chains.some((chain) => chain.id === chainId)
  return (
    <div>
      <span title={address}>{shorten(address)}</span>{' '}
      <button type="button" onClick={() => disconnect()}>
        Disconnect
      </button>
      {supported ? null : (
        <p role="alert">
          This wallet is on a chain the deployment does not monitor.{' '}
          {chains.map((chain) => (
            <button key={chain.id} type="button" onClick={() => switchChain({ chainId: chain.id })}>
              Switch to {chain.name}
            </button>
          ))}
        </p>
      )}
    </div>
  )
}
