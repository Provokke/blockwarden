import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mask, variables } from '../src/hcl.mjs'
import { check, report, REVIEWED } from '../src/sensitive-vars.mjs'

const fixtures = (name: string) => fileURLToPath(new URL(`./fixtures/sensitive/${name}`, import.meta.url))
const SCRIPT = fileURLToPath(new URL('../src/sensitive-vars.mjs', import.meta.url))
const TERRAFORM = fileURLToPath(new URL('../../../infra/terraform', import.meta.url))

describe('mask', () => {
  it('blanks strings, templates and comments and keeps every offset', () => {
    const text = 'a = "x{y}" # {\nb = "${f("}")}" // }\n/* { */ c = 1'
    const masked = mask(text)
    expect(masked).toHaveLength(text.length)
    expect(masked.split('\n')).toHaveLength(3)
    expect(masked).not.toMatch(/[{}]/)
    expect(masked).toContain('c = 1')
  })

  it('treats $${ as a literal, not a template', () => {
    expect(mask('a = "$${x" b = 1')).toContain('b = 1')
  })

  it('blanks a heredoc up to its terminator', () => {
    const masked = mask('a = <<-EOT\n  variable "x" {\n  EOT\nb = 1\n')
    expect(masked).not.toContain('variable')
    expect(masked).toContain('b = 1')
  })
})

describe('variables', () => {
  it('finds only real variable blocks, with their line, sensitivity and type attributes', async () => {
    const { readFile } = await import('node:fs/promises')
    const found = variables(await readFile(`${fixtures('clean')}/main.tf`, 'utf8'))
    expect(found.map((v) => v.name)).toEqual([
      'name',
      'webhook_secret_parameter',
      'chains',
      'password',
      'described_by_heredoc',
    ])
    expect(found.find((v) => v.name === 'chains')).toMatchObject({
      line: 18,
      sensitive: false,
      attributes: ['chain_id', 'rpc_urls_parameter'],
    })
    expect(found.find((v) => v.name === 'password')?.sensitive).toBe(true)
    // sensitive = true inside an error message is text, not the attribute
    expect(found.find((v) => v.name === 'name')?.sensitive).toBe(false)
  })
})

describe('check', () => {
  it('passes names, references and sensitive variables', async () => {
    const result = await check(fixtures('clean'), new Map())
    expect(result).toEqual({ checked: 5, problems: [], stale: [] })
  })

  it('reports every secret-looking variable and attribute that is not sensitive', async () => {
    const result = await check(fixtures('leaky'), new Map())
    expect(result.problems).toEqual([
      { file: 'main.tf', line: 1, variable: 'webhook_secret', name: 'webhook_secret' },
      { file: 'main.tf', line: 6, variable: 'api_token', name: 'api_token' },
      { file: 'main.tf', line: 11, variable: 'settings', name: 'password' },
      { file: 'nested/more.tf', line: 1, variable: 'chains', name: 'rpc_urls' },
      { file: 'nested/more.tf', line: 8, variable: 'signing_key', name: 'signing_key' },
    ])
  })

  it('excuses a reviewed variable, and reports a reviewed entry that matches nothing', async () => {
    const reviewed = new Map([
      ['main.tf:api_token', 'a fixture'],
      ['main.tf:gone', 'a fixture'],
    ])
    const result = await check(fixtures('leaky'), reviewed)
    expect(result.problems.map((p) => p.variable)).not.toContain('api_token')
    expect(result.stale).toEqual(['main.tf:gone'])
  })

  it("passes this repository's Terraform, and every reviewed entry is still needed", async () => {
    const result = await check(TERRAFORM)
    expect(result.problems).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.checked).toBeGreaterThan(50)
    expect([...REVIEWED.keys()]).toEqual(['modules/relayer/variables.tf:api_keys'])
  })
})

describe('the command', () => {
  const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })

  it('fails on a leak and names it without printing any value', () => {
    const cli = run(fixtures('leaky'))
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('main.tf:1 variable "webhook_secret" looks secret and is not sensitive = true')
    expect(cli.stderr).toContain('nested/more.tf:1 variable "chains" (its rpc_urls attribute)')
    expect(cli.stderr + cli.stdout).not.toContain('canary-value-do-not-print')
  })

  it('passes a clean tree', () => {
    const cli = run(fixtures('clean'))
    expect(cli.stderr).toBe('')
    expect(cli.stdout).toContain('5 variables checked')
  })

  it('checks infra/terraform when given no directory', () => {
    const cli = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/^\d+ variables checked/)
  })
})

it('reports a clean result in one line', () => {
  expect(report({ checked: 3, problems: [], stale: [] })).toBe(
    '3 variables checked; every secret-looking one is sensitive or reviewed',
  )
})
