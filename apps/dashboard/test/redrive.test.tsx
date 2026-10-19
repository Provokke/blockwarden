import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedriveButton } from '../src/components/RedriveButton.js'
import { apiError, json, parseCall, type Call } from './support.js'

// two deliveries, each with the ref only its own listing row carries
const REFS: Record<string, string> = { 'd-1': 'ref-of-d-1', 'd-2': 'ref-of-d-2' }
let calls: Call[]
let statuses: Record<string, string>
let hold: Promise<void> | undefined
let failure: Response | undefined

beforeEach(() => {
  calls = []
  statuses = { 'd-1': 'dead', 'd-2': 'dead' }
  hold = undefined
  failure = undefined
  // the API's own checks: the ref has to be the one for the delivery in the path, and the delivery has to be dead
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const call = parseCall(input, init)
    calls.push(call)
    if (hold) await hold
    if (failure) return failure
    const match = /^\/v1\/deliveries\/([^/]+)\/redrive$/.exec(call.path)
    if (!match || call.method !== 'POST') return apiError(404, 'route_not_found', 'no such route')
    const id = decodeURIComponent(match[1]!)
    const ref = (call.body as { ref?: string } | undefined)?.ref
    if (ref === undefined) return apiError(400, 'ref_required', 'the ref from the listing is required')
    if (ref !== REFS[id]) return apiError(400, 'ref_mismatch', 'that ref is for another delivery')
    if (statuses[id] !== 'dead') {
      return apiError(409, 'not_dead', `that delivery is ${statuses[id]}, so there is nothing to redrive`)
    }
    statuses[id] = 'pending'
    return json(200, { deliveryId: id, status: 'pending' })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('RedriveButton', () => {
  it('sends the ref the listing gave it', async () => {
    render(<RedriveButton deliveryId="d-2" deliveryRef={REFS['d-2']!} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/queued/i))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/deliveries/d-2/redrive', body: { ref: 'ref-of-d-2' } })
    expect(statuses['d-2']).toBe('pending')
  })

  it('sends a ref for another delivery as it is and shows the API refusing it', async () => {
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-2']!} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/another delivery/)
    expect(statuses['d-1']).toBe('dead')
  })

  it('disables itself while the request is in flight', async () => {
    let release: () => void = () => {}
    hold = new Promise<void>((resolve) => (release = resolve))
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={() => {}} />)
    const button = screen.getByRole('button', { name: 'Redrive' })
    await userEvent.click(button)
    await waitFor(() => expect(button).toHaveProperty('disabled', true))
    await userEvent.click(button)
    expect(calls).toHaveLength(1)
    release()
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(calls).toHaveLength(1)
  })

  it('sends one request for two clicks in the same tick, before the disabled button has rendered', async () => {
    let release: () => void = () => {}
    hold = new Promise<void>((resolve) => (release = resolve))
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={() => {}} />)
    const button = screen.getByRole('button', { name: 'Redrive' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    release()
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(calls).toHaveLength(1)
  })

  it('shows the 409 message when the delivery is no longer dead, and refreshes the list', async () => {
    statuses['d-1'] = 'sent'
    const onChanged = vi.fn()
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    expect((await screen.findByRole('alert')).textContent).toBe('that delivery is sent, so there is nothing to redrive')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('refreshes the list after a redrive, because the delivery is no longer dead', async () => {
    const onChanged = vi.fn()
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('leaves the row alone when the request fails, rather than showing it as redriven', async () => {
    failure = apiError(500, 'internal', 'the API failed to handle the request')
    const onChanged = vi.fn()
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/failed to handle/)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/queued/i)).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    // and the operator can try again
    expect(screen.getByRole('button', { name: 'Redrive' })).toHaveProperty('disabled', false)
    expect(statuses['d-1']).toBe('dead')
  })

  it('leaves the row alone when the network fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('failed to fetch')
    })
    const onChanged = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<RedriveButton deliveryId="d-1" deliveryRef={REFS['d-1']!} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Redrive' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the API/i)
    expect(screen.queryByRole('status')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
