import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/plan-comment.mjs'
import { MAX_ROWS, marker, render, summarize } from '../src/plan-summary.mjs'
import { BOT, upsertComment } from '../src/pr-comment.mjs'

const PLAN = fileURLToPath(new URL('./fixtures/plans/changes.json', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../src/plan-comment.mjs', import.meta.url))
const RUN = 'https://github.com/Provokke/blockwarden/actions/runs/42'

const plan = async () => JSON.parse(await readFile(PLAN, 'utf8'))

describe('summarize', () => {
  it('counts as Terraform does: a replacement adds one and destroys one; reads and no-ops are not changes', async () => {
    const summary = summarize(await plan())
    expect(summary).toMatchObject({ add: 3, change: 1, destroy: 3, forget: 1 })
    expect(summary.changes).toEqual([
      { address: 'module.blockwarden.module.api[0].aws_ssm_parameter.session_secret', action: 'create' },
      { address: 'module.blockwarden.aws_lambda_function.monitor["base"]', action: 'update' },
      { address: 'module.relayer.aws_sqs_queue.dead_letter', action: 'delete' },
      { address: 'module.relayer.aws_kms_key.signer["demo"]', action: 'replace' },
      { address: 'module.blockwarden.module.api[0].aws_cloudfront_distribution.site', action: 'replace' },
      { address: 'aws_sns_topic.retired', action: 'forget' },
    ])
  })

  it('never counts a data source, whatever actions it carries', () => {
    const entry = (address: string, mode: string, actions: string[]) => ({ address, mode, change: { actions } })
    const summary = summarize({
      resource_changes: [
        entry('data.aws_kms_alias.a', 'data', ['create']),
        entry('data.aws_kms_alias.b', 'data', ['delete']),
        entry('aws_sqs_queue.q', 'managed', ['create']),
      ],
    })
    expect(summary.changes).toEqual([{ address: 'aws_sqs_queue.q', action: 'create' }])
    expect(summary).toMatchObject({ add: 1, change: 0, destroy: 0, forget: 0 })
  })

  it('reads nothing from a plan but addresses and actions', async () => {
    const text = render({ environment: 'staging', summary: summarize(await plan()), runUrl: RUN, sha: 'abcdef0123' })
    const canaries = (await readFile(PLAN, 'utf8')).match(/canary-[a-z-]+/g) ?? []
    expect(canaries.length).toBeGreaterThan(10)
    for (const canary of canaries) expect(text).not.toContain(canary)
    expect(text).not.toContain('canary')
    expect(text).not.toContain('0x52908400098527886E0F7030069857D2E4169EE7')
  })
})

describe('render', () => {
  it('starts with the environment marker, then the counts, then a row per change, then the run', async () => {
    const text = render({ environment: 'staging', summary: summarize(await plan()), runUrl: RUN, sha: 'abcdef0123' })
    expect(text.split('\n').slice(0, 4)).toEqual([
      '<!-- blockwarden-plan:staging -->',
      '### Terraform plan: staging',
      '',
      '**3 to add, 1 to change, 3 to destroy, 1 to forget.**',
    ])
    expect(text).toContain('| update | `module.blockwarden.aws_lambda_function.monitor["base"]` |')
    expect(text).toContain(`[The run](${RUN}) at \`abcdef0\`.`)
  })

  it('says so when nothing changes, and when the plan failed', () => {
    const empty = { add: 0, change: 0, destroy: 0, forget: 0, changes: [] }
    expect(render({ environment: 'demo', summary: empty, runUrl: RUN, sha: 'abcdef0123' })).toContain('**No changes.**')
    const failed = render({ environment: 'demo', summary: empty, failed: true, runUrl: RUN, sha: 'abcdef0123' })
    expect(failed).toContain('**The plan failed.**')
    expect(failed.startsWith('<!-- blockwarden-plan:demo -->\n')).toBe(true)
  })

  it('keeps an address inside its cell', () => {
    const summary = {
      add: 1,
      change: 0,
      destroy: 0,
      forget: 0,
      changes: [{ address: 'a.b["x|`y\nz"]', action: 'create' }],
    }
    expect(render({ environment: 'demo', summary, runUrl: RUN, sha: 'abcdef0123' })).toContain(
      '| create | `a.b["x\\|\'y z"]` |',
    )
  })

  it('lists at most MAX_ROWS changes and says how many more there are', () => {
    const changes = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      address: `aws_sqs_queue.q${i}`,
      action: 'create',
    }))
    const text = render({
      environment: 'demo',
      summary: { add: changes.length, change: 0, destroy: 0, forget: 0, changes },
      runUrl: RUN,
      sha: 'abcdef0123',
    })
    expect(text.match(/^\| create \|/gm)).toHaveLength(MAX_ROWS)
    expect(text).toContain('And 5 more; the run has the rest.')
  })
})

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown }

// a GitHub that answers from a list of pages and records every request it was sent
function fakeGitHub(pages: unknown[][], status = 200) {
  const calls: Call[] = []
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    const page = Number(new URL(url).searchParams.get('page') ?? '0')
    const payload = init.method === 'GET' ? (pages[page - 1] ?? []) : { id: 777 }
    return { ok: status < 300, status, json: async () => payload }
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

const comment = (id: number, login: string, body: string) => ({ id, user: { login }, body })
const options = (fetch: typeof globalThis.fetch) => ({
  api: 'https://api.github.test',
  token: 'token-value',
  repository: 'Provokke/blockwarden',
  issue: '17',
  marker: marker('staging'),
  body: `${marker('staging')}\nnew body`,
  fetch,
})

describe('upsertComment', () => {
  it("edits the bot's own marked comment, found on a later page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i, 'someone', 'hello'))
    const github = fakeGitHub([full, [comment(500, BOT, `${marker('staging')}\nold body`)]])
    expect(await upsertComment(options(github.fetch))).toEqual({ action: 'updated', id: 500 })
    expect(github.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.test/repos/Provokke/blockwarden/issues/17/comments?per_page=100&page=1',
      'GET https://api.github.test/repos/Provokke/blockwarden/issues/17/comments?per_page=100&page=2',
      'PATCH https://api.github.test/repos/Provokke/blockwarden/issues/comments/500',
    ])
    expect(github.calls[2]?.body).toEqual({ body: `${marker('staging')}\nnew body` })
    for (const call of github.calls) {
      expect(call.headers.authorization).toBe('Bearer token-value')
      expect(call.headers['x-github-api-version']).toBe('2022-11-28')
    }
  })

  it("creates a comment when the only marked one is a person's, or is the other environment's", async () => {
    const github = fakeGitHub([
      [comment(1, 'someone', `${marker('staging')}\nquoted`), comment(2, BOT, `${marker('demo')}\ndemo body`)],
    ])
    expect(await upsertComment(options(github.fetch))).toEqual({ action: 'created', id: 777 })
    expect(github.calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(github.calls[1]?.url).toBe('https://api.github.test/repos/Provokke/blockwarden/issues/17/comments')
    expect(github.calls[1]?.body).toEqual({ body: `${marker('staging')}\nnew body` })
  })

  it("skips a person's marked comment ahead of the bot's own on the same page", async () => {
    const github = fakeGitHub([
      [comment(1, 'someone', `${marker('staging')}\nquoted`), comment(2, BOT, `${marker('staging')}\nold body`)],
    ])
    expect(await upsertComment(options(github.fetch))).toEqual({ action: 'updated', id: 2 })
    expect(github.calls[1]?.url).toBe('https://api.github.test/repos/Provokke/blockwarden/issues/comments/2')
  })

  it('creates after reading every page when none carries the marker, and stops on a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i, BOT, 'unrelated'))
    const github = fakeGitHub([full, [comment(500, 'someone', 'hello')]])
    expect(await upsertComment(options(github.fetch))).toEqual({ action: 'created', id: 777 })
    expect(github.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST'])
    expect(github.calls[1]?.url).toContain('page=2')
  })

  it('throws with the status and path, never the token', async () => {
    const github = fakeGitHub([], 403)
    const error = await upsertComment(options(github.fetch)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'GitHub answered 403 to GET /repos/Provokke/blockwarden/issues/17/comments?per_page=100&page=1',
    )
    expect((error as Error).message).not.toContain('token-value')
  })
})

describe('parseArgs', () => {
  it('takes an environment and either a plan or --failed', () => {
    expect(parseArgs(['--environment', 'staging', '--plan', '-'])).toEqual({
      environment: 'staging',
      plan: '-',
      failed: false,
    })
    expect(parseArgs(['--environment', 'demo', '--failed'])).toEqual({ environment: 'demo', failed: true })
    expect(() => parseArgs(['--environment', 'demo'])).toThrow('give --plan, or --failed')
    expect(() => parseArgs(['--environment', 'demo', '--plan', '-', '--failed'])).toThrow('give --plan, or --failed')
    expect(() => parseArgs(['--environment', 'Demo!', '--failed'])).toThrow('--environment')
  })
})

describe('the command', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await new Promise((done) => server?.close(done) ?? done(undefined))
  })

  // a local stand-in for the GitHub API with no comments yet; it records what it is sent
  async function startGitHub() {
    const received: { method?: string; url?: string; body: string }[] = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body })
        res.setHeader('content-type', 'application/json')
        res.end(req.method === 'GET' ? '[]' : '{"id":901}')
      })
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, received }
  }

  function run(args: string[], api: string, stdin: string) {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GITHUB_TOKEN: 'token-value',
        GITHUB_REPOSITORY: 'Provokke/blockwarden',
        PR_NUMBER: '17',
        RUN_URL: RUN,
        HEAD_SHA: 'abcdef0123',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.end(stdin)
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) =>
      child.on('close', (status) => done({ status, stdout, stderr })),
    )
  }

  it('reads the plan from stdin and posts the summary, and nothing else, as a new comment', async () => {
    const github = await startGitHub()
    const result = await run(['--environment', 'staging', '--plan', '-'], github.url, await readFile(PLAN, 'utf8'))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('created comment 901: 6 resource changes\n')
    expect(github.received.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /repos/Provokke/blockwarden/issues/17/comments?per_page=100&page=1',
      'POST /repos/Provokke/blockwarden/issues/17/comments',
    ])
    const posted = JSON.parse(github.received[1]!.body).body as string
    expect(posted.startsWith('<!-- blockwarden-plan:staging -->\n')).toBe(true)
    expect(posted).toContain('`module.relayer.aws_sqs_queue.dead_letter`')
    expect(posted).not.toContain('canary')
  })

  it('refuses a plan that is not JSON without quoting it', async () => {
    const github = await startGitHub()
    const result = await run(['--environment', 'staging', '--plan', '-'], github.url, '{"secret": "canary-unparsed"')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('the plan is not valid JSON\n')
    expect(github.received).toEqual([])
  })
})
