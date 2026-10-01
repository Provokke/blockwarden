// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BASE_DIRECTIVES, POLICY_LIMIT, assertFits, buildPolicy, collect } from '../scripts/csp-hashes.mjs'

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

describe('markup edge cases', () => {
  it('refuses an inline script holding a carriage return, naming the file', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    await page('rules/index.html', doc('<script>a = 1;\r\nb = 2;</script>'))
    const { problems } = await collect(dir)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('rules/index.html')
    expect(problems[0]).toContain('carriage return')
  })

  it('reads a > inside a quoted attribute of an inline script as part of the tag', async () => {
    await page('index.html', doc('<script data-x="a>b" data-y=\'c>d\'>window.__x = 1;</script>'))
    const result = await collect(dir)
    expect(result.hashes).toEqual([HASH_OF_SIMPLE])
    expect(result.problems).toEqual([])
  })
})

describe('--check', () => {
  it('exits 1 and names the file on a refused page', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    await page('matches/index.html', doc('<div style="x">y</div>'))
    const cli = run('--check')
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('matches/index.html')
    expect(cli.stdout).toBe('')
  })

  it('exits 0 on a clean export, printing no hashes and reporting the policy length', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    const cli = run('--check')
    expect(cli.status).toBe(0)
    expect(cli.stdout).toBe('')
    expect(cli.stderr).toContain(`1 script hashes, policy ${buildPolicy([HASH_OF_SIMPLE]).length} of ${POLICY_LIMIT}`)
  })

  // hashes are fixed width, so no export lands exactly on the limit; the boundary is checked on the function the
  // command uses
  it('passes a policy of exactly the limit and fails one character more', () => {
    expect(() => assertFits('x'.repeat(POLICY_LIMIT), 3)).not.toThrow()
    expect(() => assertFits('x'.repeat(POLICY_LIMIT + 1), 3)).toThrow(
      new RegExp(`${POLICY_LIMIT + 1}.*${POLICY_LIMIT}`),
    )
  })

  it('refuses an export with no inline scripts', async () => {
    await page('index.html', doc('<p>ok</p>'))
    const cli = run('--check')
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('no inline scripts')
  })

  it('cannot be combined with --out, which it would silently ignore', async () => {
    await page('index.html', doc('<script>window.__x = 1;</script>'))
    const out = join(dir, 'ignored.json')
    const cli = run('--check', '--out', out)
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('--check')
    await expect(readFile(out, 'utf8')).rejects.toThrow()
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

  // the text of the first block, braces balanced, that opens with the given line
  const block = (text: string, opening: RegExp): string => {
    const start = text.search(opening)
    expect(start, String(opening)).toBeGreaterThanOrEqual(0)
    let depth = 0
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++
      if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
    }
    return text.slice(start)
  }

  it('validates the hash list the same way in every place it is declared', async () => {
    const check = /validation \{\s*condition\s*=[^\n]*can\(regex\("\^sha256-\[A-Za-z0-9\+\/\]\{43\}=\$", h\)\)/
    const api = block(await read('modules/api/variables.tf'), /variable "site_script_hashes" \{/)
    const demo = block(await read('envs/demo/main.tf'), /variable "site_script_hashes" \{/)
    const staging = block(await read('envs/staging/main.tf'), /variable "site_script_hashes" \{/)
    const blockwardenVariables = await read('modules/blockwarden/variables.tf')
    const apiObject = block(blockwardenVariables, /variable "api" \{/)
    expect(api).toMatch(check)
    expect(demo).toMatch(check)
    expect(staging).toMatch(check)
    // the object's own validation sits in the api variable's block, and names the field it checks
    expect(apiObject).toMatch(check)
    expect(apiObject).toContain('var.api.site_script_hashes')
    expect(apiObject).toMatch(/site_script_hashes\s*=\s*optional\(list\(string\), \[\]\)/)

    const passed = block(await read('modules/blockwarden/api.tf'), /module "api" \{/)
    expect(passed).toMatch(/site_script_hashes\s*=\s*var\.api\.site_script_hashes/)
    for (const env of ['envs/demo/main.tf', 'envs/staging/main.tf']) {
      const envApi = block(await read(env), /\n\s*api = \{/)
      expect(envApi, env).toMatch(/site_script_hashes\s*=\s*var\.site_script_hashes/)
    }
  })

  // the apply roles hold CloudFront, API Gateway, KMS, ACM and event source mappings to their stack by the
  // environment tag. A mock provider applies no default_tags, so no plan test can see it; the tag has to be a line
  // of its own in the one aws provider that has no alias, since an aliased provider's tags reach only its resources.
  it.each([
    ['envs/demo/main.tf', 'demo'],
    ['envs/staging/main.tf', 'staging'],
  ])('%s tags every resource environment = "%s" through the default aws provider', async (file, env) => {
    const text = await read(file)
    const providers = [...text.matchAll(/^provider "aws" \{/gm)].map((m) =>
      block(text.slice(m.index), /^provider "aws" \{/),
    )
    const defaults = providers.filter((p) => !/^\s*alias\s*=/m.test(p))
    expect(defaults, file).toHaveLength(1)
    expect(defaults[0], file).toMatch(new RegExp(`^\\s*environment\\s*=\\s*"${env}"\\s*$`, 'm'))
  })
})
