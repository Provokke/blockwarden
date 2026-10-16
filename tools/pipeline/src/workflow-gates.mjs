// Every workflow job that assumes an AWS role must do nothing until the repository variable holding that role's
// ARN is set, and must say so in its summary when it skips. This checks that shape in each workflow file.
// Usage: node tools/pipeline/src/workflow-gates.mjs [directory]   (default .github/workflows)
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const AWS_ACTION = 'aws-actions/configure-aws-credentials@'
export const ROLE_VARIABLE = /^BLOCKWARDEN_[A-Z_]+_ROLE_ARN$/
const ROLE_EXPRESSION = /^\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}$/
// the gate's output, alone or first in a conjunction; an || could run the step with the gate shut
const GATED = /^(\$\{\{\s*)?steps\.gate\.outputs\.enabled == 'true'(\s*&&[^|]*)?(\s*\}\})?$/

// The gated jobs in one workflow, as { job, roleVariable, gate }, where gate is the first step's script, and the
// problems found, each naming its job.
export function checkWorkflow(text) {
  const workflow = parse(text)
  const jobs = []
  const problems = []
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    if (!steps.some((s) => typeof s?.uses === 'string' && s.uses.startsWith(AWS_ACTION))) continue
    const problem = (message) => problems.push(`${name}: ${message}`)

    const roleVariable = ROLE_EXPRESSION.exec(String(job.env?.ROLE_ARN ?? ''))?.[1]
    if (roleVariable === undefined || !ROLE_VARIABLE.test(roleVariable)) {
      problem('env.ROLE_ARN must be ${{ vars.BLOCKWARDEN_<NAME>_ROLE_ARN }}')
    } else if (job.env?.ROLE_VARIABLE !== roleVariable) {
      problem(`env.ROLE_VARIABLE must name ${roleVariable}, the variable ROLE_ARN reads`)
    }

    const [gate, ...rest] = steps
    if (gate?.id !== 'gate' || gate.if !== undefined || typeof gate.run !== 'string') {
      problem('the first step must be the ungated run step with id gate')
    } else if (gate.run.includes('${{')) {
      problem('the gate script must read ROLE_ARN from the environment, not from an expression')
    }
    for (const [index, step] of rest.entries()) {
      if (typeof step?.if !== 'string' || !GATED.test(step.if.trim())) {
        problem(
          `step ${index + 2} (${step?.name ?? step?.uses ?? 'run'}) must run only if steps.gate.outputs.enabled == 'true'`,
        )
      }
      if (
        typeof step?.uses === 'string' &&
        step.uses.startsWith(AWS_ACTION) &&
        step.with?.['role-to-assume'] !== '${{ env.ROLE_ARN }}'
      ) {
        problem('configure-aws-credentials must assume ${{ env.ROLE_ARN }}')
      }
    }
    jobs.push({ job: name, roleVariable, gate: typeof gate?.run === 'string' ? gate.run : '' })
  }
  return { jobs, problems }
}

export async function checkDirectory(dir) {
  const results = []
  for (const file of (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    results.push({ file, ...checkWorkflow(await readFile(join(dir, file), 'utf8')) })
  }
  return results
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../.github/workflows', import.meta.url)))
  const results = await checkDirectory(dir)
  const problems = results.flatMap((r) => r.problems.map((p) => `${r.file} ${p}`))
  for (const r of results) for (const j of r.jobs) console.log(`${r.file} ${j.job}: gated on ${j.roleVariable}`)
  for (const p of problems) console.error(p)
  process.exitCode = problems.length > 0 ? 1 : 0
}
