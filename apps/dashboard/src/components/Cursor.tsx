'use client'

export function Cursor({ hasMore, busy, onLoad }: { hasMore: boolean; busy: boolean; onLoad: () => void }) {
  if (!hasMore) return null
  return (
    <p>
      <button type="button" onClick={onLoad} disabled={busy}>
        {busy ? 'Loading...' : 'Load more'}
      </button>
    </p>
  )
}
