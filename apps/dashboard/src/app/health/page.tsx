'use client'

import { useQuery } from '@tanstack/react-query'
import type { Column } from '../../components/DataTable'
import { DataTable } from '../../components/DataTable'
import { Problem } from '../../components/Problem'
import { apiFetch } from '../../lib/api'
import { chainName } from '../../lib/chains'

type ChainHealth = { durableBlock: string | null; fastBlock: string | null; cursorAgeSeconds: number | null }
type QueueHealth = { visible: number; inFlight: number }
type Health = { chains: Record<string, ChainHealth | null>; queues: Record<string, QueueHealth | null> }

const UNAVAILABLE = 'unavailable'
const NOT_STARTED = 'not started'

function formatAge(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const part = (n: number, unit: string) => (n === 0 ? [] : [`${n} ${unit}${n === 1 ? '' : 's'}`])
  const parts = [...part(hours, 'hour'), ...part(minutes, 'minute'), ...part(rest, 'second')]
  return parts.length > 0 ? parts.join(' ') : '0 seconds'
}

type ChainRow = { chainId: number; health: ChainHealth | null }
type QueueRow = { name: string; health: QueueHealth | null }

// A chain the monitor has not started reports nulls; a chain whose read failed reports null altogether. They
// are different states and read differently.
const CHAIN_COLUMNS: Column<ChainRow>[] = [
  { header: 'Chain', cell: (row) => chainName(row.chainId) },
  { header: 'Durable block', cell: (row) => (row.health ? (row.health.durableBlock ?? NOT_STARTED) : UNAVAILABLE) },
  { header: 'Fast block', cell: (row) => (row.health ? (row.health.fastBlock ?? NOT_STARTED) : UNAVAILABLE) },
  {
    // seconds since the monitor last wrote its cursor, not how far the chain has moved past it
    header: 'Cursor staleness',
    cell: (row) =>
      row.health
        ? row.health.cursorAgeSeconds === null
          ? // the row exists but carries no readable write time: not the same as a monitor that never ran
            row.health.durableBlock !== null || row.health.fastBlock !== null
            ? 'unknown'
            : NOT_STARTED
          : formatAge(row.health.cursorAgeSeconds)
        : UNAVAILABLE,
  },
]

const QUEUE_COLUMNS: Column<QueueRow>[] = [
  { header: 'Queue', cell: (row) => row.name },
  { header: 'Visible', cell: (row) => (row.health ? row.health.visible : UNAVAILABLE) },
  { header: 'In flight', cell: (row) => (row.health ? row.health.inFlight : UNAVAILABLE) },
]

export default function HealthPage() {
  const health = useQuery({ queryKey: ['/v1/health'], queryFn: () => apiFetch<Health>('/v1/health') })
  return (
    <main>
      <h1>Health</h1>
      {health.isPending ? <p className="muted">Loading...</p> : null}
      {health.error ? <Problem error={health.error} onRetry={() => void health.refetch()} /> : null}
      {health.data ? (
        <>
          <p className="muted">
            Staleness is how long ago the monitor last wrote each cursor. It is not how far behind the chain it is, and
            a recent cursor does not show the monitor is keeping up.
          </p>
          <h2>Chains</h2>
          <DataTable
            columns={CHAIN_COLUMNS}
            rows={Object.entries(health.data.chains)
              .map(([id, chainHealth]) => ({ chainId: Number(id), health: chainHealth }))
              .sort((a, b) => a.chainId - b.chainId)}
            rowKey={(row) => String(row.chainId)}
            empty="No chains configured."
          />
          <h2>Queues</h2>
          <DataTable
            columns={QUEUE_COLUMNS}
            rows={Object.entries(health.data.queues).map(([name, queueHealth]) => ({ name, health: queueHealth }))}
            rowKey={(row) => row.name}
            empty="No queues configured."
          />
          <p>
            <button type="button" onClick={() => void health.refetch()}>
              Refresh
            </button>
          </p>
        </>
      ) : null}
    </main>
  )
}
