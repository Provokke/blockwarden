import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, json, paged, parseCall, renderWithClient, type Call } from './support.js'

const nav = vi.hoisted(() => ({ search: '', push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const { default: RulesPage } = await import('../src/app/rules/page.js')
const { default: EditRulePage } = await import('../src/app/rules/edit/page.js')
const { default: MatchesPage } = await import('../src/app/matches/page.js')
const { default: DeliveriesPage } = await import('../src/app/deliveries/page.js')
const { default: RelayerPage } = await import('../src/app/relayer/page.js')
const { default: HealthPage } = await import('../src/app/health/page.js')
const { chainName } = await import('../src/lib/chains.js')

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const rule = (n: number, over: Record<string, unknown> = {}) => ({
  ruleId: `rule-${n}`,
  active: n % 2 === 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  chainId: n === 3 ? 8453 : 1,
  addresses: [ADDRESS],
  event: `event Thing${n}(uint256 value)`,
  confirmation: { mode: n === 2 ? 'fast' : 'finalized' },
  actions: Array.from({ length: n }, () => ({ type: 'email', to: ['a@example.com'] })),
  ...over,
})
const RULES = [1, 2, 3, 4, 5].map((n) => rule(n))

let calls: Call[]
let handler: (call: Call) => Response | undefined

function rowsOf(table: HTMLElement) {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell'))
}

beforeEach(() => {
  calls = []
  nav.search = ''
  nav.push.mockReset()
  handler = () => undefined
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const call = parseCall(input, init)
    calls.push(call)
    const custom = handler(call)
    if (custom) return custom
    if (call.method === 'GET' && call.path === '/v1/rules') return paged(RULES, call.query, 'rules')
    return apiError(404, 'route_not_found', 'no such route')
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chainName', () => {
  it('names a configured chain and falls back to the id for one it does not know', () => {
    expect(chainName(1)).toBe('Ethereum')
    expect(chainName(999)).toBe('999')
  })
})

describe('Rules', () => {
  it('shows chain, event, confirmation, action count and active state, with links into the rule', async () => {
    renderWithClient(<RulesPage />)
    const table = await screen.findByRole('table')
    const first = rowsOf(table)[0]!
    expect(first.map((cell) => cell.textContent)).toEqual([
      'Ethereum',
      'event Thing1(uint256 value)',
      'finalized',
      '1',
      'active',
      'Edit Matches',
    ])
    const second = rowsOf(table)[1]!
    expect(second[2]!.textContent).toBe('fast')
    expect(second[4]!.textContent).toBe('inactive')
    expect(within(first[5]!).getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/rules/edit/?ruleId=rule-1',
    )
    expect(within(first[5]!).getByRole('link', { name: 'Matches' }).getAttribute('href')).toBe(
      '/matches/?ruleId=rule-1',
    )
  })

  it('asks for the next page with the cursor the first one returned', async () => {
    renderWithClient(<RulesPage />)
    await screen.findByRole('table')
    expect(rowsOf(screen.getByRole('table'))).toHaveLength(2)
    const firstCursor = await (async () => {
      const res = await fetch('/v1/rules?limit=2')
      return ((await res.json()) as { cursor: string }).cursor
    })()
    calls.length = 0

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(4))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.query.get('cursor')).toBe(firstCursor)
    // the second page is different rows, appended; rule 3 is on Base
    expect(rowsOf(screen.getByRole('table'))[2]![0]!.textContent).toBe('Base')
    expect(rowsOf(screen.getByRole('table')).map((r) => r[1]!.textContent)).toEqual([
      'event Thing1(uint256 value)',
      'event Thing2(uint256 value)',
      'event Thing3(uint256 value)',
      'event Thing4(uint256 value)',
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(5))
    // the last page carried no cursor, so there is nothing more to ask for
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('shows an empty state instead of an empty table', async () => {
    handler = (call) => (call.path === '/v1/rules' ? json(200, { rules: [] }) : undefined)
    renderWithClient(<RulesPage />)
    expect(await screen.findByText(/no rules yet/i)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('sends someone with no session to sign in, not to a raw error', async () => {
    handler = () => apiError(401, 'unauthorized', 'sign in required')
    renderWithClient(<RulesPage />)
    const link = await screen.findByRole('link', { name: /sign in/i })
    expect(link.getAttribute('href')).toBe('/')
  })

  it('shows the API refusal and lets the operator retry', async () => {
    let failing = true
    handler = (call) =>
      failing && call.path === '/v1/rules'
        ? apiError(500, 'internal', 'the API failed to handle the request')
        : undefined
    renderWithClient(<RulesPage />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/failed to handle/)
    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })
})

describe('Edit rule', () => {
  it('reads the id from the query string and loads that rule', async () => {
    nav.search = 'ruleId=rule-3'
    handler = (call) => {
      if (call.path === '/v1/rules/rule-3') return json(200, rule(3))
      return undefined
    }
    renderWithClient(<EditRulePage />)
    expect(await screen.findByLabelText('Event signature')).toHaveProperty('value', 'event Thing3(uint256 value)')
    expect(screen.getByLabelText('Chain')).toHaveProperty('value', '8453')
    expect(calls.map((c) => c.path)).toContain('/v1/rules/rule-3')
  })

  it('says so when no rule is named, without asking the API', () => {
    renderWithClient(<EditRulePage />)
    expect(screen.getByText(/choose a rule/i)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('shows the 404 for a rule that is gone', async () => {
    nav.search = 'ruleId=gone'
    handler = (call) =>
      call.path === '/v1/rules/gone' ? apiError(404, 'rule_not_found', 'no rule has that id') : undefined
    renderWithClient(<EditRulePage />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/no rule has that id/)
  })
})

const MATCHES = [1, 2, 3, 4, 5].map((n) => ({
  matchKey: `m-${n}`,
  ruleId: 'rule-1',
  chainId: 1,
  blockNumber: String(1000 + n),
  blockHash: `0xblock${n}`,
  transactionHash: `0xtx${n}`,
  logIndex: n,
  address: ADDRESS,
  args: { value: String(n * 100) },
  status: n % 2 === 0 ? 'final' : 'provisional',
  firstSeenAt: '2026-09-03T00:00:00.000Z',
}))

function matchesApi(call: Call): Response | undefined {
  if (call.path !== '/v1/matches') return undefined
  if (call.query.get('ruleId') !== 'rule-1') return apiError(400, 'rule_required', 'ruleId is required')
  const wanted = call.query.get('status')
  const rows = wanted ? MATCHES.filter((m) => m.status === wanted) : MATCHES
  return paged(rows, call.query, 'matches')
}

describe('Matches', () => {
  it('shows a rule picker, not an error, when no rule is chosen', async () => {
    renderWithClient(<MatchesPage />)
    const link = await screen.findByRole('link', { name: 'event Thing1(uint256 value)' })
    expect(link.getAttribute('href')).toBe('/matches/?ruleId=rule-1')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.every((c) => c.path === '/v1/rules')).toBe(true)
  })

  it('lists the matches of the chosen rule and pages with the cursor it was given', async () => {
    nav.search = 'ruleId=rule-1'
    handler = matchesApi
    renderWithClient(<MatchesPage />)
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(2))
    expect(calls[0]!.query.get('ruleId')).toBe('rule-1')
    const first = rowsOf(screen.getByRole('table'))[0]!.map((c) => c.textContent)
    expect(first).toContain('1001')
    expect(first).toContain('0xtx1')
    expect(first).toContain('provisional')
    expect(first.join(' ')).toContain('"value":"100"')

    const returned = await (await fetch('/v1/matches?ruleId=rule-1&limit=2')).json()
    calls.length = 0
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(4))
    expect(calls[0]!.query.get('cursor')).toBe((returned as { cursor: string }).cursor)
    expect(calls[0]!.query.get('ruleId')).toBe('rule-1')
  })

  it('sends the status filter and starts the list again from its first page', async () => {
    nav.search = 'ruleId=rule-1'
    handler = matchesApi
    renderWithClient(<MatchesPage />)
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(4))
    calls.length = 0

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'final')
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('provisional')).toBeNull())
    expect(calls[0]!.query.get('status')).toBe('final')
    expect(calls[0]!.query.has('cursor')).toBe(false)
    // the fake filters by the status it was given, so only final matches can be listed
    const table = screen.getByRole('table')
    expect(within(table).queryByText('provisional')).toBeNull()
    expect(within(table).getAllByText('final').length).toBeGreaterThan(0)
  })
})

const DEAD = [1, 2, 3].map((n) => ({
  deliveryId: `d-${n}`,
  ref: `ref-${n}`,
  subject: `MATCH#${n}`,
  channel: 'webhook',
  target: `https://hooks.example.com/${'*'.repeat(3)}`,
  status: 'dead',
  attempts: 8,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T01:00:00.000Z',
  lastError: n === 1 ? 'receiver answered 500' : undefined,
  lastStatusCode: n === 1 ? 500 : undefined,
}))

describe('Deliveries', () => {
  let dead: typeof DEAD
  beforeEach(() => {
    dead = [...DEAD]
    handler = (call) => {
      if (call.method === 'GET' && call.path === '/v1/deliveries') {
        if (call.query.get('status') !== 'dead')
          return apiError(400, 'filter_required', 'status=dead or a subject is required')
        return paged(dead, call.query, 'deliveries')
      }
      const redrive = /^\/v1\/deliveries\/([^/]+)\/redrive$/.exec(call.path)
      if (redrive && call.method === 'POST') {
        const index = dead.findIndex((d) => d.deliveryId === redrive[1])
        const ref = (call.body as { ref?: string }).ref
        if (index < 0) return apiError(409, 'not_dead', 'that delivery is pending, so there is nothing to redrive')
        if (dead[index]!.ref !== ref) return apiError(400, 'ref_mismatch', 'that ref is for another delivery')
        dead.splice(index, 1)
        return json(200, { deliveryId: redrive[1], status: 'pending' })
      }
      return undefined
    }
  })

  it('lists only dead deliveries, says so, and shows what an operator needs to judge one', async () => {
    renderWithClient(<DeliveriesPage />)
    const table = await screen.findByRole('table')
    expect(calls[0]!.query.get('status')).toBe('dead')
    expect(screen.getByText(/only dead deliveries are listed/i)).toBeTruthy()
    const first = rowsOf(table)[0]!.map((c) => c.textContent)
    expect(first).toEqual(
      expect.arrayContaining(['webhook', 'https://hooks.example.com/***', '8', 'receiver answered 500', '500']),
    )
    expect(within(table).getAllByRole('button', { name: 'Redrive' })).toHaveLength(2)
  })

  it("redrives the row it is on with that row's ref, then reloads the list", async () => {
    renderWithClient(<DeliveriesPage />)
    const table = await screen.findByRole('table')
    calls.length = 0
    await userEvent.click(within(rowsOf(table)[1]!.at(-1)!).getByRole('button', { name: 'Redrive' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.path).toBe('/v1/deliveries/d-2/redrive')
    expect(post.body).toEqual({ ref: 'ref-2' })
    // d-2 left the dead list, so the reloaded first page now starts d-1, d-3
    await waitFor(() => expect(rowsOf(screen.getByRole('table')).map((r) => r[0]!.textContent).length).toBe(2))
    await waitFor(() => expect(screen.queryByText('d-2')).toBeNull())
    expect(dead.map((d) => d.deliveryId)).toEqual(['d-1', 'd-3'])
  })

  it('pages with the cursor from the first page', async () => {
    renderWithClient(<DeliveriesPage />)
    await screen.findByRole('table')
    const firstCursor = ((await (await fetch('/v1/deliveries?status=dead&limit=2')).json()) as { cursor: string })
      .cursor
    calls.length = 0
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(3))
    expect(calls[0]!.query.get('cursor')).toBe(firstCursor)
    expect(calls[0]!.query.get('status')).toBe('dead')
  })
})

const TXS = [1, 2, 3].map((n) => ({
  txId: `tx-${n}`,
  signerId: n === 3 ? 'ops' : 'main',
  chainId: 1,
  status: 'submitted',
  createdAt: '2026-09-05T00:00:00.000Z',
  to: ADDRESS,
  nonce: n,
  hash: `0xhash${n}`,
}))

describe('Relayer', () => {
  beforeEach(() => {
    handler = (call) => {
      if (call.path === '/v1/relayer/signers') {
        return json(200, {
          signers: [
            { signerId: 'main', chainIds: [1, 8453], address: ADDRESS },
            { signerId: 'ops', chainIds: [1] },
          ],
        })
      }
      if (call.path === '/v1/relayer/txs') {
        if (call.query.get('status') !== 'pending')
          return apiError(400, 'unsupported_status', 'only status=pending is indexed')
        return paged(TXS, call.query, 'txs')
      }
      return undefined
    }
  })

  it('lists signers with their chains, and says a session reads but does not submit', async () => {
    renderWithClient(<RelayerPage />)
    const tables = await screen.findAllByRole('table')
    const signers = rowsOf(tables[0]!).map((r) => r.map((c) => c.textContent))
    expect(signers[0]).toEqual(['main', 'Ethereum, Base', ADDRESS])
    // a signer whose row carries no address is shown without one, not with a guess
    expect(signers[1]![0]).toBe('ops')
    expect(signers[1]![2]).toBe('')
    expect(screen.getByText(/a session reads the relayer but cannot submit/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /submit|send|relay/i })).toBeNull()
  })

  it('lists pending transactions and pages with the cursor it was given', async () => {
    renderWithClient(<RelayerPage />)
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))
    const txTable = () => screen.getAllByRole('table')[1]!
    await waitFor(() => expect(rowsOf(txTable())).toHaveLength(2))
    const txCalls = () => calls.filter((c) => c.path === '/v1/relayer/txs')
    expect(txCalls()[0]!.query.get('status')).toBe('pending')
    const firstCursor = ((await (await fetch('/v1/relayer/txs?status=pending&limit=2')).json()) as { cursor: string })
      .cursor
    calls.length = 0
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rowsOf(txTable())).toHaveLength(3))
    expect(txCalls()[0]!.query.get('cursor')).toBe(firstCursor)
    expect(txCalls()[0]!.query.get('status')).toBe('pending')
  })
})

describe('Health', () => {
  it('labels the cursor age as staleness, not lag, and shows queue depths', async () => {
    handler = (call) =>
      call.path === '/v1/health'
        ? json(200, {
            chains: {
              '1': { durableBlock: '1234567', fastBlock: '1234600', cursorAgeSeconds: 125 },
              '8453': { durableBlock: null, fastBlock: null, cursorAgeSeconds: null },
              '42161': null,
            },
            queues: { delivery: { visible: 3, inFlight: 1 }, 'dead-letter': null },
          })
        : undefined
    renderWithClient(<HealthPage />)
    const [chains, queues] = await screen.findAllByRole('table')
    expect(within(chains!).getByRole('columnheader', { name: 'Cursor staleness' })).toBeTruthy()
    expect(screen.queryByText(/lag/i)).toBeNull()
    const rows = rowsOf(chains!).map((r) => r.map((c) => c.textContent))
    expect(rows[0]).toEqual(['Ethereum', '1234567', '1234600', '2 minutes 5 seconds'])
    expect(rows[1]).toEqual(['Base', 'not started', 'not started', 'not started'])
    expect(rows[2]![0]).toBe('Arbitrum One')
    expect(rows[2]!.slice(1).join(' ')).toMatch(/unavailable/)
    const queueRows = rowsOf(queues!).map((r) => r.map((c) => c.textContent))
    expect(queueRows[0]).toEqual(['delivery', '3', '1'])
    expect(queueRows[1]![1]).toMatch(/unavailable/)
  })
})
