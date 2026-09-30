'use client'

import type { Paged } from '../lib/paged'
import { Cursor } from './Cursor'
import { DataTable, type Column } from './DataTable'
import { Problem } from './Problem'

export function PagedList<T>({
  list,
  columns,
  rowKey,
  empty,
}: {
  list: Paged<T>
  columns: Column<T>[]
  rowKey: (row: T) => string
  empty: string
}) {
  if (list.loading) return <p className="muted">Loading...</p>
  // rows already loaded stay on screen when a later page fails, so the error sits above them
  return (
    <>
      {list.error ? <Problem error={list.error} onRetry={list.reload} /> : null}
      {list.error && list.rows.length === 0 ? null : (
        <DataTable columns={columns} rows={list.rows} rowKey={rowKey} empty={empty} />
      )}
      <Cursor hasMore={list.hasMore} busy={list.loadingMore} onLoad={list.loadMore} />
    </>
  )
}
