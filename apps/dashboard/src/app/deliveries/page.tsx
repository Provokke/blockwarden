'use client'

import type { Column } from '../../components/DataTable'
import { PagedList } from '../../components/PagedList'
import { RedriveButton } from '../../components/RedriveButton'
import { usePagedList } from '../../lib/paged'

type Delivery = {
  deliveryId: string
  ref: string
  channel: string
  target: string
  status: string
  attempts: number
  updatedAt: string
  lastError?: string
  lastStatusCode?: number
}

export default function DeliveriesPage() {
  const list = usePagedList<Delivery>('/v1/deliveries', 'deliveries', { status: 'dead' })
  const columns: Column<Delivery>[] = [
    { header: 'Channel', cell: (d) => d.channel },
    { header: 'Target', cell: (d) => <code className="wrap">{d.target}</code> },
    { header: 'Attempts', cell: (d) => d.attempts },
    { header: 'Last error', cell: (d) => d.lastError ?? '' },
    { header: 'Status code', cell: (d) => d.lastStatusCode ?? '' },
    { header: 'Updated', cell: (d) => d.updatedAt },
    {
      header: 'Redrive',
      cell: (d) => <RedriveButton deliveryId={d.deliveryId} deliveryRef={d.ref} onChanged={list.reload} />,
    },
  ]
  return (
    <main>
      <h1>Deliveries</h1>
      <p>
        Only dead deliveries are listed: they are the only status the table indexes, and any other would need a scan of
        the whole table.
      </p>
      <PagedList list={list} columns={columns} rowKey={(d) => d.deliveryId} empty="No dead deliveries." />
    </main>
  )
}
