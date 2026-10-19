'use client'

import Link from 'next/link'
import { ApiError } from '../lib/api'

export function Problem({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.code === 'unauthorized') {
    return (
      <p role="alert">
        You are not signed in, or your session has ended. <Link href="/">Sign in</Link>
      </p>
    )
  }
  const message = error instanceof ApiError ? error.message : 'Could not reach the API.'
  return (
    <p role="alert">
      {message}{' '}
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </p>
  )
}
