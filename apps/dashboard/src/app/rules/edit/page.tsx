'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { Problem } from '../../../components/Problem'
import { RuleForm, type RuleBody } from '../../../components/RuleForm'
import { apiFetch } from '../../../lib/api'

function EditRule() {
  const ruleId = useSearchParams().get('ruleId')
  const router = useRouter()
  const queryClient = useQueryClient()
  const rule = useQuery({
    queryKey: ['/v1/rules', ruleId],
    enabled: ruleId !== null && ruleId !== '',
    queryFn: () => apiFetch<RuleBody>(`/v1/rules/${encodeURIComponent(ruleId ?? '')}`),
  })

  if (!ruleId) {
    return (
      <p>
        Choose a rule from the <Link href="/rules/">rules list</Link> to edit it.
      </p>
    )
  }
  if (rule.isPending) return <p className="muted">Loading...</p>
  if (rule.error) return <Problem error={rule.error} onRetry={() => void rule.refetch()} />

  return (
    <RuleForm
      // a different rule is a different form; without the key the previous rule's typing would carry over
      key={rule.data.ruleId}
      initial={rule.data}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: ['/v1/rules'] })
        router.push('/rules/')
      }}
    />
  )
}

export default function EditRulePage() {
  return (
    <main>
      <h1>Edit rule</h1>
      {/* useSearchParams has no value at build time, and a static export fails without a boundary to defer it to */}
      <Suspense fallback={<p className="muted">Loading...</p>}>
        <EditRule />
      </Suspense>
    </main>
  )
}
