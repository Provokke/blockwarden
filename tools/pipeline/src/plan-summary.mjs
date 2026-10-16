// Turns `terraform show -json` of a saved plan into the pull request comment: counts, then each resource address
// and its action. The plan JSON holds every value in the plan, sensitive ones included, in plain text; only
// resource_changes[].address and change.actions are ever read from it, so nothing else can reach the comment.

export const MAX_ROWS = 200

export const marker = (environment) => `<!-- blockwarden-plan:${environment} -->`

function classify(actions) {
  const key = [...actions].sort().join(',')
  if (key === 'create') return 'create'
  if (key === 'update') return 'update'
  if (key === 'delete') return 'delete'
  if (key === 'create,delete') return 'replace'
  if (key === 'forget') return 'forget'
  return null
}

export function summarize(plan) {
  const changes = []
  for (const change of plan?.resource_changes ?? []) {
    if (change?.mode === 'data') continue
    const action = classify(Array.isArray(change?.change?.actions) ? change.change.actions : [])
    if (action === null || typeof change.address !== 'string') continue
    changes.push({ address: change.address, action })
  }
  const count = (...actions) => changes.filter((c) => actions.includes(c.action)).length
  return {
    add: count('create', 'replace'),
    change: count('update'),
    destroy: count('delete', 'replace'),
    forget: count('forget'),
    changes,
  }
}

// an address in a table cell: no pipe to split the row, no backtick to end the code span, one line
const cell = (address) => `\`${address.replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\s+/g, ' ')}\``

export function render({ environment, summary, failed = false, runUrl, sha }) {
  const lines = [marker(environment), `### Terraform plan: ${environment}`, '']
  if (failed) {
    lines.push("**The plan failed.** The run's log has Terraform's error.")
  } else if (summary.changes.length === 0) {
    lines.push('**No changes.**')
  } else {
    const counts = [`${summary.add} to add`, `${summary.change} to change`, `${summary.destroy} to destroy`]
    if (summary.forget > 0) counts.push(`${summary.forget} to forget`)
    lines.push(`**${counts.join(', ')}.**`, '', '| Action | Resource |', '|---|---|')
    for (const c of summary.changes.slice(0, MAX_ROWS)) lines.push(`| ${c.action} | ${cell(c.address)} |`)
    if (summary.changes.length > MAX_ROWS)
      lines.push('', `And ${summary.changes.length - MAX_ROWS} more; the run has the rest.`)
  }
  const at = sha === undefined ? '' : ` at \`${sha.slice(0, 7)}\``
  lines.push(
    '',
    `[The run](${runUrl})${at}. Only addresses and actions are posted, never the plan itself: this repository's comments and logs are public.`,
  )
  return `${lines.join('\n')}\n`
}
