import { MATCH_STATUSES, TX_STATUSES, type MatchStatus, type TxStatus } from '@blockwarden/relayer-client'
import type { Row, StreamChange } from './stream.js'

export type MatchChange = {
  kind: 'match'
  subject: string
  matchKey: string
  ruleId: string
  event: `match.${MatchStatus}`
  seq: 0
  at: string
  row: Row
}

export type TxChange = {
  kind: 'tx'
  subject: string
  txId: string
  event: `tx.${TxStatus}`
  seq: number
  at: string
  row: Row
}

export type Change = MatchChange | TxChange

const isMatchStatus = (v: unknown): v is MatchStatus => (MATCH_STATUSES as readonly unknown[]).includes(v)
const isTxStatus = (v: unknown): v is TxStatus => (TX_STATUSES as readonly unknown[]).includes(v)

// history is a list of { status, at }; historyBase counts the entries dropped off the front
function entries(row: Row): { seq: number; status: unknown; at: unknown }[] {
  const base = typeof row.historyBase === 'number' ? row.historyBase : 0
  const history = Array.isArray(row.history) ? row.history : []
  return history.map((entry, i) => ({ seq: base + i, ...(entry as { status: unknown; at: unknown }) }))
}

function count(row: Row | undefined): number {
  if (!row) return 0
  const base = typeof row.historyBase === 'number' ? row.historyBase : 0
  return base + (Array.isArray(row.history) ? row.history.length : 0)
}

export function changesFor(change: StreamChange): Change[] {
  // a deletion is a TTL expiry or an operator's DeleteItem, neither of which is something that happened on chain
  if (change.eventName === 'REMOVE' || !change.newImage) return []
  // every item kind shares the table; a delivery even shares its partition key with the match it belongs to
  if (change.sk !== 'META') return []
  const row = change.newImage

  if (change.pk.startsWith('MATCH#')) {
    const { status } = row
    if (!isMatchStatus(status)) return []
    if (change.oldImage?.status === status) return []
    if (typeof row.matchKey !== 'string' || typeof row.ruleId !== 'string') return []
    return [
      {
        kind: 'match',
        subject: change.pk,
        matchKey: row.matchKey,
        ruleId: row.ruleId,
        event: `match.${status}`,
        seq: 0,
        at: new Date().toISOString(),
        row,
      },
    ]
  }

  if (change.pk.startsWith('TX#')) {
    if (typeof row.txId !== 'string') return []
    const from = count(change.oldImage)
    return entries(row)
      .filter((entry) => entry.seq >= from && isTxStatus(entry.status))
      .map((entry) => ({
        kind: 'tx' as const,
        subject: change.pk,
        txId: row.txId as string,
        event: `tx.${entry.status as TxStatus}` as const,
        seq: entry.seq,
        at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
        row,
      }))
  }

  return []
}
