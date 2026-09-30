export type RuleRow = {
  ruleId: string
  active: boolean
  chainId: number
  event: string
  confirmation: { mode: string }
  actions: unknown[]
}

// `?ruleId=` is a query string, not a path segment: a static export has no page for an id it did not see at build,
// and the slash before the `?` is the export's trailing slash
export const ruleLinks = {
  edit: (ruleId: string) => `/rules/edit/?ruleId=${encodeURIComponent(ruleId)}`,
  matches: (ruleId: string) => `/matches/?ruleId=${encodeURIComponent(ruleId)}`,
}
