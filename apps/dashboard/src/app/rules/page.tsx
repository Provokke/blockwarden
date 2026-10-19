'use client'

import Link from 'next/link'
import { PagedList } from '../../components/PagedList'
import type { Column } from '../../components/DataTable'
import { chainName } from '../../lib/chains'
import { usePagedList } from '../../lib/paged'
import { ruleLinks, type RuleRow } from '../../lib/rules'

const COLUMNS: Column<RuleRow>[] = [
  { header: 'Chain', cell: (rule) => chainName(rule.chainId) },
  { header: 'Event', cell: (rule) => <code>{rule.event}</code> },
  { header: 'Confirmation', cell: (rule) => rule.confirmation.mode },
  { header: 'Actions', cell: (rule) => rule.actions.length },
  { header: 'State', cell: (rule) => (rule.active ? 'active' : 'inactive') },
  {
    header: 'Links',
    cell: (rule) => (
      <>
        <Link href={ruleLinks.edit(rule.ruleId)}>Edit</Link> <Link href={ruleLinks.matches(rule.ruleId)}>Matches</Link>
      </>
    ),
  },
]

export default function RulesPage() {
  const list = usePagedList<RuleRow>('/v1/rules', 'rules')
  return (
    <main>
      <h1>Rules</h1>
      <p>
        <Link href="/rules/new/">New rule</Link>
      </p>
      <PagedList list={list} columns={COLUMNS} rowKey={(rule) => rule.ruleId} empty="No rules yet." />
    </main>
  )
}
