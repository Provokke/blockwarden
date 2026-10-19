import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuleForm, type RuleBody } from '../src/components/RuleForm.js'
import { apiError, json, parseCall, type Call } from './support.js'

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TRANSFER = 'event Transfer(address indexed from, address indexed to, uint256 value)'

let calls: Call[]
let respond: (call: Call) => Response | Promise<Response>

// a stand-in for the API's validation that looks at what it is sent: a refusal follows from the body, not from a
// switch the test flipped
function fakeValidation(call: Call): Response {
  const body = call.body as {
    event?: string
    conditions?: { all?: { field?: string }[] }
    actions?: { type: string; url?: string }[]
  }
  const issues: { path: string; message: string }[] = []
  if (!body.event?.includes('(')) issues.push({ path: 'event', message: 'cannot parse event signature (SyntaxError)' })
  const leaf = body.conditions?.all?.[0]
  if (leaf && leaf.field !== 'value')
    issues.push({ path: 'conditions.all.0.field', message: `unknown field "${leaf.field}"` })
  body.actions?.forEach((action, index) => {
    if (action.type === 'webhook' && /^https?:\/\/169\.254\./.test(action.url ?? '')) {
      issues.push({ path: `actions.${index}.url`, message: 'destination is a link-local address' })
    }
  })
  if (issues.length > 0) return apiError(400, 'invalid_rule', 'the rule is not valid', issues)
  return json(call.method === 'POST' ? 201 : 200, { ruleId: 'r-1', active: true, ...body })
}

beforeEach(() => {
  calls = []
  respond = fakeValidation
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const call = parseCall(input, init)
    calls.push(call)
    return respond(call)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function describedBy(element: HTMLElement): string {
  const ids = element.getAttribute('aria-describedby')?.split(' ') ?? []
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
}

async function fillBasics(event = TRANSFER) {
  await userEvent.type(screen.getByLabelText('Contract addresses (one per line)'), ADDRESS)
  const field = screen.getByLabelText('Event signature')
  await userEvent.clear(field)
  await userEvent.type(field, event)
}

describe('RuleForm', () => {
  it('shows a compile issue against the field it names, not at the top of the form', async () => {
    render(<RuleForm onSaved={() => {}} />)
    await fillBasics('Transfer')
    await userEvent.click(screen.getByLabelText('Conditions (JSON, optional)'))
    await userEvent.paste('{"all":[{"field":"nope","op":"eq","value":1}]}')
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))

    await waitFor(() =>
      expect(describedBy(screen.getByLabelText('Event signature'))).toMatch(/cannot parse event signature/),
    )
    expect(describedBy(screen.getByLabelText('Conditions (JSON, optional)'))).toMatch(
      /conditions\.all\.0\.field.*unknown field "nope"/,
    )
    // nothing about either issue was left for a summary at the top
    expect(screen.queryByRole('alert')).toBeNull()
    // and a field the issue does not name carries none of it
    expect(describedBy(screen.getByLabelText('Contract addresses (one per line)'))).toBe('')
  })

  it('keeps what the operator typed when the API refuses it', async () => {
    render(<RuleForm onSaved={() => {}} />)
    await fillBasics('Transfer')
    await userEvent.selectOptions(screen.getByLabelText('Confirmation'), 'fast')
    await userEvent.click(screen.getByRole('button', { name: 'Add action' }))
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.com/hook')
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => expect(describedBy(screen.getByLabelText('Event signature'))).not.toBe(''))

    expect(screen.getByLabelText('Event signature')).toHaveProperty('value', 'Transfer')
    expect(screen.getByLabelText('Contract addresses (one per line)')).toHaveProperty('value', ADDRESS)
    expect(screen.getByLabelText('Confirmation')).toHaveProperty('value', 'fast')
    expect(screen.getByLabelText('URL')).toHaveProperty('value', 'https://example.com/hook')
    // the form is usable again for a corrected attempt
    expect(screen.getByRole('button', { name: 'Create rule' })).toHaveProperty('disabled', false)
  })

  it('shows the refusal for a webhook URL the SSRF guard rejects', async () => {
    render(<RuleForm onSaved={() => {}} />)
    await fillBasics()
    await userEvent.click(screen.getByRole('button', { name: 'Add action' }))
    await userEvent.type(screen.getByLabelText('URL'), 'http://169.254.169.254/latest')
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))

    await waitFor(() => expect(describedBy(screen.getByLabelText('URL'))).toMatch(/link-local/))
    expect(screen.getByLabelText('URL').getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(screen.getByLabelText('Event signature'))).toBe('')
  })

  it('shows a refusal that names no field at the top, and keeps the form', async () => {
    respond = () => apiError(502, 'bad_gateway', 'the API is not answering')
    render(<RuleForm onSaved={() => {}} />)
    await fillBasics()
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/the API is not answering/)
    expect(screen.getByLabelText('Event signature')).toHaveProperty('value', TRANSFER)
  })

  it('refuses conditions that are not JSON without sending anything', async () => {
    render(<RuleForm onSaved={() => {}} />)
    await fillBasics()
    await userEvent.type(screen.getByLabelText('Conditions (JSON, optional)'), 'not json')
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(describedBy(screen.getByLabelText('Conditions (JSON, optional)'))).toMatch(/JSON/)
    expect(calls).toHaveLength(0)
  })

  it('disables submit while the request is in flight, so one click is one rule', async () => {
    let release: (response: Response) => void = () => {}
    respond = () => new Promise<Response>((resolve) => (release = resolve))
    const onSaved = vi.fn()
    render(<RuleForm onSaved={onSaved} />)
    await fillBasics()

    const submit = screen.getByRole('button', { name: 'Create rule' })
    await userEvent.click(submit)
    await waitFor(() => expect(submit).toHaveProperty('disabled', true))
    await userEvent.click(submit)
    await userEvent.keyboard('{Enter}')
    expect(calls).toHaveLength(1)

    release(json(201, { ruleId: 'r-1', active: true }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(calls).toHaveLength(1)
  })

  it('creates a rule with a POST of the fields as typed', async () => {
    const onSaved = vi.fn()
    render(<RuleForm onSaved={onSaved} />)
    await fillBasics()
    await userEvent.selectOptions(screen.getByLabelText('Chain'), '8453')
    await userEvent.click(screen.getByRole('button', { name: 'Add action' }))
    await userEvent.selectOptions(screen.getByLabelText('Action 1 type'), 'email')
    await userEvent.type(screen.getByLabelText('Recipients (comma separated)'), 'a@example.com, b@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Create rule' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/rules',
      body: {
        chainId: 8453,
        addresses: [ADDRESS],
        event: TRANSFER,
        confirmation: { mode: 'finalized' },
        actions: [{ type: 'email', to: ['a@example.com', 'b@example.com'] }],
      },
    })
    // a blank optional field is left out, not sent as an empty string
    expect(calls[0]!.body).not.toHaveProperty('actions.0.subject')
    expect(calls[0]!.body).not.toHaveProperty('conditions')
  })

  describe('editing', () => {
    const stored: RuleBody = {
      ruleId: 'rule 7/a',
      active: true,
      chainId: 8453,
      addresses: [ADDRESS, '0x000000000000000000000000000000000000dEaD'],
      event: TRANSFER,
      conditions: { all: [{ field: 'value', op: 'gt', value: '100' }] },
      confirmation: { mode: 'fast' },
      actions: [
        { type: 'webhook', url: 'https://example.com/hook', secretParameter: '/bw/rules/hook' },
        { type: 'relay', signerId: 's1', chainId: 8453, to: ADDRESS, data: '0x', gasLimit: '21000' },
      ],
    }

    it('sends the whole rule on a patch, because a partial rule cannot be compiled', async () => {
      const onSaved = vi.fn()
      render(<RuleForm initial={stored} onSaved={onSaved} />)
      const event = screen.getByLabelText('Event signature')
      await userEvent.clear(event)
      await userEvent.type(event, 'event Approval(address indexed owner, address indexed spender, uint256 value)')
      await userEvent.click(screen.getByRole('button', { name: 'Save rule' }))

      await waitFor(() => expect(onSaved).toHaveBeenCalled())
      expect(calls).toHaveLength(1)
      // only the event changed, and every other part of the rule travels with it
      expect(calls[0]).toEqual({
        method: 'PATCH',
        path: '/v1/rules/rule%207%2Fa',
        query: expect.any(URLSearchParams),
        body: {
          active: true,
          chainId: 8453,
          addresses: stored.addresses,
          event: 'event Approval(address indexed owner, address indexed spender, uint256 value)',
          conditions: stored.conditions,
          confirmation: { mode: 'fast' },
          actions: stored.actions,
        },
      })
    })

    it('sends the active state the operator chose', async () => {
      render(<RuleForm initial={stored} onSaved={() => {}} />)
      await userEvent.click(screen.getByLabelText('Active'))
      await userEvent.click(screen.getByRole('button', { name: 'Save rule' }))
      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]!.body).toMatchObject({ active: false })
    })

    it('shows an action issue inside the action it names', async () => {
      render(<RuleForm initial={stored} onSaved={() => {}} />)
      const first = screen.getByRole('group', { name: 'Action 1' })
      const url = within(first).getByLabelText('URL')
      await userEvent.clear(url)
      await userEvent.type(url, 'http://169.254.169.254/x')
      await userEvent.click(screen.getByRole('button', { name: 'Save rule' }))
      await waitFor(() => expect(describedBy(url)).toMatch(/link-local/))
      const second = screen.getByRole('group', { name: 'Action 2' })
      expect(describedBy(within(second).getByLabelText('To address'))).toBe('')
    })
  })
})
