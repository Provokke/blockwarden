'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { RuleForm } from '../../../components/RuleForm'

export default function NewRulePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  return (
    <main>
      <h1>New rule</h1>
      <RuleForm
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['/v1/rules'] })
          router.push('/rules/')
        }}
      />
    </main>
  )
}
