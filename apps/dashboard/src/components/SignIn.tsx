'use client'

import { useState } from 'react'
import { createSiweMessage } from 'viem/siwe'
import { useConnection, useSignMessage } from 'wagmi'
import { ApiError, apiFetch } from '../lib/api'
import { chains } from '../lib/chains'

// The API refuses a message with no expiry, or one further out than its nonce lifetime, so this stays well
// inside that and leaves room for the wallet prompt and for a browser clock that runs ahead.
const MESSAGE_LIFETIME_MS = 2 * 60 * 1000

function isRejection(err: unknown): boolean {
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const { name, code } = e as { name?: unknown; code?: unknown }
    if (name === 'UserRejectedRequestError' || code === 4001) return true
  }
  return false
}

function describe(err: unknown): string {
  if (isRejection(err)) return 'The signature request was cancelled in the wallet. Try again when you are ready.'
  if (err instanceof ApiError) return err.message
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage
  if (typeof short === 'string' && short) return `Sign-in failed: ${short}`
  return 'Sign-in failed. Check the wallet and try again.'
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { address, chainId, isConnected } = useConnection()
  const { mutateAsync: signMessage } = useSignMessage()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  // a wallet on another chain would spend a nonce on a message the API is bound to refuse (siwe_chain)
  if (!isConnected || !address || chainId === undefined || !chains.some((chain) => chain.id === chainId)) return null

  async function signIn() {
    if (!address || chainId === undefined) return
    setBusy(true)
    setProblem(undefined)
    try {
      // a nonce is single use and spent on the first verify, so every attempt, retries included, asks for its own
      const { nonce } = await apiFetch<{ nonce: string }>('/v1/auth/siwe/nonce', { method: 'POST' })
      const message = createSiweMessage({
        address,
        chainId,
        // the API compares both to the deployment it is serving, so they come from the page actually in use
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to Blockwarden.',
        nonce,
        expirationTime: new Date(Date.now() + MESSAGE_LIFETIME_MS),
      })
      const signature = await signMessage({ message })
      await apiFetch('/v1/auth/siwe/verify', { method: 'POST', body: { message, signature } })
      onSignedIn()
    } catch (err) {
      // wallet and API errors carry no secrets, and this is the only trace of an unexpected failure
      console.error('sign-in failed', err)
      setProblem(describe(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={signIn} disabled={busy}>
        {busy ? 'Waiting for the wallet...' : 'Sign in with Ethereum'}
      </button>
      {problem ? <p role="alert">{problem}</p> : null}
    </div>
  )
}
