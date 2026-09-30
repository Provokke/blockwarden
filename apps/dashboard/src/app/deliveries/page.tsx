'use client'

import { useState } from 'react'
import type { Column } from '../../components/DataTable'
import { PagedList } from '../../components/PagedList'
import { RedriveButton, type Settled } from '../../components/RedriveButton'
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
  // by delivery id: the reload that follows a redrive removes the row, and its button with it
  const [notices, setNotices] = useState<Record<string, Settled>>({})
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
      cell: (d) => (
        <RedriveButton
          deliveryId={d.deliveryId}
          deliveryRef={d.ref}
          onChanged={list.reload}
          onSettled={(settled) => setNotices((current) => ({ ...current, [d.deliveryId]: settled }))}
        />
      ),
    },
  ]
  return (
    <main>
      <h1>Deliveries</h1>
      <p>
        Only dead deliveries are listed: they are the only status the table indexes, and any other would need a scan of
        the whole table.
      </p>
      <section aria-label="Redrive results">
        {Object.entries(notices).map(([id, notice]) =>
          notice.kind === 'sent' ? (
            <p key={id} role="status">{`Delivery ${id} was queued again.`}</p>
          ) : (
            <p key={id} role="alert">{`Delivery ${id}: ${notice.message}`}</p>
          ),
        )}
      </section>
      <PagedList list={list} columns={columns} rowKey={(d) => d.deliveryId} empty="No dead deliveries." />
    </main>
  )
}
