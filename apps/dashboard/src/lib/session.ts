'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from './api'

export type SessionState = 'loading' | 'signedIn' | 'signedOut' | 'error'

// There is no session route: an existing one already answers, and a 401 from it means signed out. A
// different failure (a 502, the network) is not the same thing and must not send the user to a login form
// that cannot work.
export function useSession(): { state: SessionState; refresh: () => void } {
  const [state, setState] = useState<SessionState>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    apiFetch('/v1/rules?limit=1').then(
      () => current && setState('signedIn'),
      (err: unknown) => current && setState(err instanceof ApiError && err.status === 401 ? 'signedOut' : 'error'),
    )
    return () => {
      current = false
    }
  }, [attempt])

  const refresh = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, refresh }
}
