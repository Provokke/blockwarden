'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import type { Column } from '../../components/DataTable'
import { PagedList } from '../../components/PagedList'
import { chainName } from '../../lib/chains'
import { usePagedList } from '../../lib/paged'
import { ruleLinks, type RuleRow } from '../../lib/rules'

type Match = {
  matchKey: string
  chainId: number
  blockNumber: string
  transactionHash: string
  logIndex: number
  address: string
  args: Record<string, unknown>
  status: 'provisional' | 'final' | 'dropped'
  firstSeenAt: string
  finalizedAt?: string
}

const STATUSES = ['provisional', 'final', 'dropped'] as const

const COLUMNS: Column<Match>[] = [
  { header: 'Block', cell: (match) => match.blockNumber },
  { header: 'Transaction', cell: (match) => <code className="wrap">{match.transactionHash}</code> },
  { header: 'Log', cell: (match) => match.logIndex },
  { header: 'Contract', cell: (match) => <code className="wrap">{match.address}</code> },
  { header: 'Arguments', cell: (match) => <code className="wrap">{JSON.stringify(match.args)}</code> },
  { header: 'Status', cell: (match) => match.status },
  { header: 'First seen', cell: (match) => match.firstSeenAt },
]

// the matches index is per rule, so with no rule chosen there is nothing to ask the API for
function RulePicker() {
  const list = usePagedList<RuleRow>('/v1/rules', 'rules')
  const columns: Column<RuleRow>[] = [
    {
      header: 'Rule',
      cell: (rule) => <Link href={ruleLinks.matches(rule.ruleId)}>{rule.event}</Link>,
    },
    { header: 'Chain', cell: (rule) => chainName(rule.chainId) },
  ]
  return (
    <>
      <p>Matches are kept per rule. Choose one.</p>
      <PagedList list={list} columns={columns} rowKey={(rule) => rule.ruleId} empty="No rules yet." />
    </>
  )
}

function RuleMatches({ ruleId }: { ruleId: string }) {
  const [status, setStatus] = useState('')
  const list = usePagedList<Match>('/v1/matches', 'matches', { ruleId, status: status || undefined })
  const router = useRouter()
  return (
    <>
      <p>
        Rule <code>{ruleId}</code> <Link href={ruleLinks.edit(ruleId)}>Edit</Link>{' '}
        <button type="button" onClick={() => router.push('/matches/')}>
          Choose another rule
        </button>
      </p>
      <div className="field">
        <label htmlFor="match-status">Status</label>
        <select id="match-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <PagedList list={list} columns={COLUMNS} rowKey={(match) => match.matchKey} empty="No matches yet." />
    </>
  )
}

function Matches() {
  const ruleId = useSearchParams().get('ruleId')
  return ruleId ? <RuleMatches key={ruleId} ruleId={ruleId} /> : <RulePicker />
}

export default function MatchesPage() {
  return (
    <main>
      <h1>Matches</h1>
      {/* useSearchParams has no value at build time, and a static export fails without a boundary to defer it to */}
      <Suspense fallback={<p className="muted">Loading...</p>}>
        <Matches />
      </Suspense>
    </main>
  )
}
