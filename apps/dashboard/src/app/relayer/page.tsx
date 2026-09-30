'use client'

import { useQuery } from '@tanstack/react-query'
import type { Column } from '../../components/DataTable'
import { DataTable } from '../../components/DataTable'
import { PagedList } from '../../components/PagedList'
import { Problem } from '../../components/Problem'
import { apiFetch } from '../../lib/api'
import { chainName } from '../../lib/chains'
import { usePagedList } from '../../lib/paged'

type Signer = { signerId: string; chainIds: number[]; address?: string }
type Tx = {
  txId: string
  signerId: string
  chainId: number
  status: string
  createdAt: string
  to?: string
  nonce?: number
  hash?: string
}

const SIGNER_COLUMNS: Column<Signer>[] = [
  { header: 'Signer', cell: (s) => s.signerId },
  { header: 'Chains', cell: (s) => s.chainIds.map(chainName).join(', ') },
  { header: 'Address', cell: (s) => (s.address ? <code className="wrap">{s.address}</code> : '') },
]

const TX_COLUMNS: Column<Tx>[] = [
  { header: 'Transaction', cell: (tx) => <code className="wrap">{tx.txId}</code> },
  { header: 'Signer', cell: (tx) => tx.signerId },
  { header: 'Chain', cell: (tx) => chainName(tx.chainId) },
  { header: 'Status', cell: (tx) => tx.status },
  { header: 'To', cell: (tx) => (tx.to ? <code className="wrap">{tx.to}</code> : '') },
  { header: 'Nonce', cell: (tx) => tx.nonce ?? '' },
  { header: 'Hash', cell: (tx) => (tx.hash ? <code className="wrap">{tx.hash}</code> : '') },
  { header: 'Created', cell: (tx) => tx.createdAt },
]

export default function RelayerPage() {
  const signers = useQuery({
    queryKey: ['/v1/relayer/signers'],
    queryFn: () => apiFetch<{ signers: Signer[] }>('/v1/relayer/signers'),
  })
  const txs = usePagedList<Tx>('/v1/relayer/txs', 'txs', { status: 'pending' })
  return (
    <main>
      <h1>Relayer</h1>
      <p>A session reads the relayer but cannot submit. Transactions are submitted with an API key.</p>

      <h2>Signers</h2>
      {signers.isPending ? <p className="muted">Loading...</p> : null}
      {signers.error ? <Problem error={signers.error} onRetry={() => void signers.refetch()} /> : null}
      {signers.data ? (
        <DataTable
          columns={SIGNER_COLUMNS}
          rows={signers.data.signers}
          rowKey={(s) => s.signerId}
          empty="No signers."
        />
      ) : null}

      <h2>Pending transactions</h2>
      <PagedList list={txs} columns={TX_COLUMNS} rowKey={(tx) => tx.txId} empty="No pending transactions." />
    </main>
  )
}
