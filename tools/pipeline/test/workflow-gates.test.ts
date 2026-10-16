import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDirectory, checkWorkflow } from '../src/workflow-gates.mjs'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/workflows/${name}`, import.meta.url))
const WORKFLOWS = fileURLToPath(new URL('../../../.github/workflows', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../src/workflow-gates.mjs', import.meta.url))

// Every job in this repository that assumes an AWS role, and the variable that switches it on. A new AWS job
// fails this test until it is listed here.
const EXPECTED: Record<string, Record<string, string>> = {
  'ci.yml': {},
  'deploy.yml': { staging: 'BLOCKWARDEN_STAGING_APPLY_ROLE_ARN', demo: 'BLOCKWARDEN_DEMO_APPLY_ROLE_ARN' },
  'plan.yml': { plan: 'BLOCKWARDEN_PLAN_ROLE_ARN' },
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gate-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// runs a gate script as GitHub would, with bash and the two files it writes to
async function runGate(script: string, roleArn: string, roleVariable = 'BLOCKWARDEN_PLAN_ROLE_ARN') {
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  await writeFile(output, '')
  await writeFile(summary, '')
  const result = spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROLE_ARN: roleArn,
      ROLE_VARIABLE: roleVariable,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  return { ...result, output: await readFile(output, 'utf8'), summary: await readFile(summary, 'utf8') }
}

describe('checkWorkflow', () => {
  it('accepts a gated job and ignores a job that never touches AWS', async () => {
    const { jobs, problems } = checkWorkflow(await readFile(fixture('gated.yml'), 'utf8'))
    expect(problems).toEqual([])
    expect(jobs.map((j) => [j.job, j.roleVariable])).toEqual([['plan', 'BLOCKWARDEN_PLAN_ROLE_ARN']])
  })

  it('names every way a job can reach AWS without its variable', async () => {
    const { problems } = checkWorkflow(await readFile(fixture('broken.yml'), 'utf8'))
    expect(problems).toEqual([
      'no-role-env: env.ROLE_ARN must be ${{ vars.BLOCKWARDEN_<NAME>_ROLE_ARN }}',
      'mismatched-variable: env.ROLE_VARIABLE must name BLOCKWARDEN_DEMO_APPLY_ROLE_ARN, the variable ROLE_ARN reads',
      'gate-not-first: the first step must be the ungated run step with id gate',
      "gate-not-first: step 2 (run) must run only if steps.gate.outputs.enabled == 'true'",
      'ungated-and-or: the gate script must read ROLE_ARN from the environment, not from an expression',
      "ungated-and-or: step 2 (aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd) must run only if steps.gate.outputs.enabled == 'true'",
      'ungated-and-or: configure-aws-credentials must assume ${{ env.ROLE_ARN }}',
      "ungated-and-or: step 3 (terraform plan) must run only if steps.gate.outputs.enabled == 'true'",
      'gate-not-named: the first step must be the ungated run step with id gate',
      'action-in-other-case: env.ROLE_ARN must be ${{ vars.BLOCKWARDEN_<NAME>_ROLE_ARN }}',
      'action-in-other-case: the first step must be the ungated run step with id gate',
    ])
  })
})

describe('a conjunction in a step condition', () => {
  const workflow = (condition: string) => `jobs:
  plan:
    env:
      ROLE_ARN: \${{ vars.BLOCKWARDEN_PLAN_ROLE_ARN }}
      ROLE_VARIABLE: BLOCKWARDEN_PLAN_ROLE_ARN
    steps:
      - id: gate
        run: echo "enabled=true" >> "$GITHUB_OUTPUT"
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd
        if: ${condition}
        with:
          role-to-assume: \${{ env.ROLE_ARN }}
`

  it('is accepted when the gate comes first and nothing is ORed in', () => {
    expect(
      checkWorkflow(workflow("steps.gate.outputs.enabled == 'true' && github.ref == 'refs/heads/main'")).problems,
    ).toEqual([])
  })

  it('is refused when an || can run the step with the gate shut', () => {
    const { problems } = checkWorkflow(
      workflow("steps.gate.outputs.enabled == 'true' && github.ref == 'x' || always()"),
    )
    expect(problems).toHaveLength(1)
  })
})

describe('the gate script', () => {
  it('shuts the gate and writes a summary notice when the variable is unset', async () => {
    const { jobs } = checkWorkflow(await readFile(fixture('gated.yml'), 'utf8'))
    const gate = await runGate(jobs[0]!.gate, '')
    expect(gate.status).toBe(0)
    expect(gate.output).toBe('enabled=false\n')
    expect(gate.stdout).toContain('::notice::BLOCKWARDEN_PLAN_ROLE_ARN is not set')
    expect(gate.summary).toContain('`BLOCKWARDEN_PLAN_ROLE_ARN` is not set')
  })

  it('opens the gate, silently, when the variable is set', async () => {
    const { jobs } = checkWorkflow(await readFile(fixture('gated.yml'), 'utf8'))
    const gate = await runGate(jobs[0]!.gate, 'arn:aws:iam::123456789012:role/blockwarden-plan')
    expect(gate.status).toBe(0)
    expect(gate.output).toBe('enabled=true\n')
    expect(gate.summary).toBe('')
  })
})

describe("this repository's workflows", () => {
  it('gates every AWS job on its own role variable', async () => {
    const results = await checkDirectory(WORKFLOWS)
    expect(results.flatMap((r) => r.problems)).toEqual([])
    expect(
      Object.fromEntries(results.map((r) => [r.file, Object.fromEntries(r.jobs.map((j) => [j.job, j.roleVariable]))])),
    ).toEqual(EXPECTED)
  })

  it('skips with a summary notice, and runs once the variable is set, in every gated job', async () => {
    for (const { file, jobs } of await checkDirectory(WORKFLOWS)) {
      for (const job of jobs) {
        const shut = await runGate(job.gate, '', job.roleVariable)
        expect(shut.output, `${file} ${job.job}`).toBe('enabled=false\n')
        expect(shut.stdout, `${file} ${job.job}`).toContain(`::notice::${job.roleVariable} is not set`)
        expect(shut.summary, `${file} ${job.job}`).toContain(`\`${job.roleVariable}\` is not set`)
        const open = await runGate(job.gate, 'arn:aws:iam::123456789012:role/r', job.roleVariable)
        expect(open.output, `${file} ${job.job}`).toBe('enabled=true\n')
      }
    }
  })

  it("deploy.yml's two jobs differ only in the stack they name", async () => {
    const { parse } = await import('yaml')
    const { jobs } = parse(await readFile(join(WORKFLOWS, 'deploy.yml'), 'utf8'))
    const neutral = (job: unknown, name: string) =>
      JSON.stringify(job).replaceAll(name.toUpperCase(), 'STACK').replaceAll(name, 'stack')
    const { if: stagingIf, ...staging } = jobs.staging
    const { if: demoIf, ...demo } = jobs.demo
    expect(neutral(staging, 'staging')).toBe(neutral(demo, 'demo'))
    expect(stagingIf).toBe(
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.environment == 'staging')",
    )
    expect(demoIf).toBe(
      "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.environment == 'demo'",
    )
  })

  it('the command passes them and fails a broken one', () => {
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(0)
    const broken = spawnSync(
      process.execPath,
      [SCRIPT, fileURLToPath(new URL('./fixtures/workflows', import.meta.url))],
      {
        encoding: 'utf8',
      },
    )
    expect(broken.status).toBe(1)
    expect(broken.stderr).toContain('broken.yml no-role-env: env.ROLE_ARN must be')
    expect(broken.stdout).toContain('gated.yml plan: gated on BLOCKWARDEN_PLAN_ROLE_ARN')
  })
})
