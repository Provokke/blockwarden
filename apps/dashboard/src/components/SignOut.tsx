'use client'

import { useState } from 'react'
import { ApiError, apiFetch } from '../lib/api'

// Disconnecting the wallet leaves the HttpOnly session cookie alone, so ending the session is the API's job.
export function SignOut({ onSignedOut }: { onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  async function signOut() {
    setBusy(true)
    setProblem(undefined)
    try {
      await apiFetch('/v1/auth/logout', { method: 'POST' })
      onSignedOut()
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not reach the API, so you are still signed in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={signOut} disabled={busy}>
        Sign out
      </button>
      {problem ? <p role="alert">{problem}</p> : null}
    </div>
  )
}
