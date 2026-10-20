// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BASE_DIRECTIVES, POLICY_LIMIT, buildPolicy, collect } from '../scripts/csp-hashes.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/csp-hashes.mjs', import.meta.url))
const TERRAFORM = fileURLToPath(new URL('../../../infra/terraform/', import.meta.url))

// The expected hashes are literals, computed with a different tool: printf '<content>' | openssl dgst -sha256
// -binary | openssl base64. None of them comes from the code under test.
const HASH_OF_SIMPLE = 'sha256-lyTN6OpbNBmA84UPafLhT+mqPgMl6Zh8SXt5ZSZ/s1g=' // window.__x = 1;
const HASH_OF_PADDED = 'sha256-829G1b/jnY3cTLxS5Es0/1BjdhmZWwB2IJqt0Kez49E=' // "\n  self.__next_f = [];\n"
const HASH_OF_JSON = 'sha256-AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=' // {"a":1}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csp-hashes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function page(path: string, html: string): Promise<void> {
  const file = join(dir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, html)
}

const doc = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], { encoding: 'utf8' })
}

describe('the hashes', () => {
  it('cover the exact content of an inline script, whitespace included', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script><script>\n  self.__next_f = [];\n</script>'))
    expect((await collect(dir)).hashes).toEqual([HASH_OF_PADDED, HASH_OF_SIMPLE].sort())
  })

  it('skip a script with a src and keep a data block', async () => {
    await page(
      'index.html',
      doc('<script src="/_next/a.js" async=""></script><script type="application/json">{"a":1}</script>'),
    )
    expect((await collect(dir)).hashes).toEqual([HASH_OF_JSON])
  })

  it('are unique across pages and sorted', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    await page(
      'rules/index.html',
      doc('<script>window.__x = 1;</script><script type="application/json">{"a":1}</script>'),
    )
    const { hashes } = await collect(dir)
    expect(hashes).toHaveLength(2)
    expect(hashes).toEqual([...hashes].sort())
    expect(new Set(hashes)).toEqual(new Set([HASH_OF_SIMPLE, HASH_OF_JSON]))
  })

  it('are not fooled by markup-looking text inside a script', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    await page('a/index.html', doc('<script>self.f = \'<div style="x" onclick="y">javascript:z</div>\'</script>'))
    expect((await collect(dir)).problems).toEqual([])
  })
})

describe('a page the policy cannot admit', () => {
  it.each([
    ['a style attribute', '<div style="color:red">x</div>'],
    ['a style element', '<style>p{color:red}</style>'],
    ['an event handler', '<button onclick="go()">x</button>'],
    ['a javascript: URL', '<a href="javascript:go()">x</a>'],
  ])('is refused for %s, naming the file', async (_name, body) => {
    await page('index.html', doc('<p>ok</p>'))
    await page('rules/index.html', doc(body))
    const result = await collect(dir)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain('rules/index.html')

    const cli = run()
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('rules/index.html')
    expect(cli.stdout).toBe('')
  })
})

describe('the not-found exemption', () => {
  it.each(['404.html', '404/index.html', '_not-found/index.html', '_not-found/deep/index.html'])(
    'lets %s carry inline styles, keeps its script hash, and says so',
    async (path) => {
      await page(path, doc('<div style="color:red">x</div><script>window.__x = 1;</script>'))
      const result = await collect(dir)
      expect(result.problems).toEqual([])
      expect(result.hashes).toEqual([HASH_OF_SIMPLE])
      expect(result.exemptions.join('\n')).toContain(path)

      const cli = run()
      expect(cli.status).toBe(0)
      expect(cli.stderr).toContain(path)
    },
  )

  it('applies to no other path', async () => {
    await page('rules/404.html', doc('<div style="color:red">x</div>'))
    await page('404x/index.html', doc('<div style="color:red">x</div>'))
    const result = await collect(dir)
    expect(result.problems).toHaveLength(2)
    expect(result.exemptions).toEqual([])
  })

  it('does not cover an event handler', async () => {
    await page('404.html', doc('<button onclick="go()">x</button>'))
    expect((await collect(dir)).problems).toHaveLength(1)
  })
})

describe('the command', () => {
  it('prints the hashes as JSON, or writes them with --out', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    const printed = run()
    expect(printed.status).toBe(0)
    expect(JSON.parse(printed.stdout)).toEqual({ site_script_hashes: [HASH_OF_SIMPLE] })

    const out = join(dir, 'nested', 'site.auto.tfvars.json')
    const written = run('--out', out)
    expect(written.status).toBe(0)
    expect(written.stdout).toBe('')
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ site_script_hashes: [HASH_OF_SIMPLE] })
  })

  it('refuses a policy over the limit, and names its length and the limit', async () => {
    const scripts = Array.from({ length: Math.ceil(POLICY_LIMIT / 40) }, (_, i) => `<script>var n${i}=${i}</script>`)
    await page('index.html', doc(scripts.join('')))
    const out = join(dir, 'never.json')
    const cli = run('--out', out)
    expect(cli.status).toBe(1)
    const length = buildPolicy((await collect(dir)).hashes).length
    expect(length).toBeGreaterThan(POLICY_LIMIT)
    expect(cli.stderr).toContain(String(length))
    expect(cli.stderr).toContain(String(POLICY_LIMIT))
    await expect(readFile(out, 'utf8')).rejects.toThrow()
  })

  it('fails when there is no export to read', async () => {
    const cli = spawnSync(process.execPath, [SCRIPT, '--dir', join(dir, 'missing')], { encoding: 'utf8' })
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('missing')
  })
})

describe('the Terraform policy', () => {
  const stripComments = (text: string) => text.replace(/^\s*#.*$/gm, '')
  const read = async (path: string) => stripComments(await readFile(join(TERRAFORM, path), 'utf8'))

  it('has the base directives the script measures', async () => {
    const site = await read('modules/api/site.tf')
    const list = /content_security_policy = join\("; ", \[([\s\S]*?)\]\)/.exec(site)?.[1] ?? ''
    const directives = [...list.matchAll(/^\s*"(.*)",?\s*$/gm)].map((m) => m[1])
    const scriptSrc = directives.filter((d) => d?.startsWith('script-src '))
    expect(scriptSrc).toEqual(['script-src ${local.script_src}'])
    expect(directives.map((d) => (d?.startsWith('script-src ') ? 'script-src' : d))).toEqual(
      BASE_DIRECTIVES.map((d: string) => (d.startsWith('script-src ') ? 'script-src' : d)),
    )
    expect(BASE_DIRECTIVES.filter((d: string) => d.startsWith('script-src '))).toEqual([`script-src 'self'`])
  })

  it("builds script-src as 'self' then each hash in single quotes, in the order given", async () => {
    const site = await read('modules/api/site.tf')
    expect(site).toMatch(
      /script_src\s*=\s*join\(" ", concat\(\["'self'"\], \[for h in var\.site_script_hashes : "'\$\{h\}'"\]\)\)/,
    )
    expect(buildPolicy([HASH_OF_SIMPLE, HASH_OF_JSON])).toContain(
      `script-src 'self' '${HASH_OF_SIMPLE}' '${HASH_OF_JSON}'; `,
    )
  })

  it('validates the hash list the same way in every place it is declared', async () => {
    const pattern = '"^sha256-[A-Za-z0-9+/]{43}=$"'
    const api = await read('modules/api/variables.tf')
    const blockwarden = await read('modules/blockwarden/variables.tf')
    const demo = await read('envs/demo/main.tf')
    expect(api).toContain(`can(regex(${pattern}, h))`)
    expect(blockwarden).toContain(`can(regex(${pattern}, h))`)
    expect(demo).toContain(`can(regex(${pattern}, h))`)
    expect(await read('modules/blockwarden/api.tf')).toMatch(/site_script_hashes\s*=\s*var\.api\.site_script_hashes/)
    expect(demo).toMatch(/site_script_hashes\s*=\s*var\.site_script_hashes/)
  })
})
