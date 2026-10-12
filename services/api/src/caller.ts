import type { Address } from 'viem'

export type Caller =
  { kind: 'session'; address: Address } | { kind: 'apiKey'; hash: string; signerIds: string[]; label: string }

export function isDashboard(caller: Caller): boolean {
  return caller.kind === 'session'
}

export function mayUseSigner(caller: Caller, signerId: string): boolean {
  // a signed-in operator owns the deployment; a key owns only what Terraform listed for it
  return caller.kind === 'session' || caller.signerIds.includes(signerId)
}
