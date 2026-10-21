import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, json, parseCall, type Call } from './support.js'

vi.mock('wagmi', () => ({
  useConnection: () => ({ address: undefined, chainId: undefined, isConnected: false }),
  useConnect: () => ({ mutate: () => {}, error: null }),
  useConnectors: () => [],
  useDisconnect: () => ({ mutate: () => {} }),
  useSwitchChain: () => ({ mutate: () => {} }),
  useSignMessage: () => ({ mutateAsync: async () => '0x' }),
}))

const { default: Home } = await import('../src/app/page.js')

let calls: Call[]
let cookieValid: boolean
let logout: () => Response

beforeEach(() => {
  calls = []
  cookieValid = true
  // the real route clears the cookie and answers { ok: true }; the session probe answers 401 once it is gone
  logout = () => {
    cookieValid = false
    return json(200, { ok: true })
  }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const call = parseCall(input, init)
    calls.push(call)
    if (call.method === 'POST' && call.path === '/v1/auth/logout') return logout()
    if (call.path === '/v1/rules') {
      return cookieValid ? json(200, { rules: [] }) : apiError(401, 'unauthorized', 'sign in required')
    }
    return apiError(404, 'not_found', 'no such route')
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Sign out', () => {
  it('posts to the logout route and returns the page to the signed-out view', async () => {
    render(<Home />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull())

    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/v1/auth/logout'])
    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('shows a refused logout and stays signed in', async () => {
    logout = () => apiError(500, 'internal', 'the API failed')
    render(<Home />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect((await screen.findByRole('alert')).textContent).toContain('the API failed')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(screen.getByText('Signed in.')).toBeTruthy()
  })

  it('shows an unreachable API as a failure, not as a sign-out', async () => {
    logout = () => {
      throw new TypeError('network')
    }
    render(<Home />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/still signed in/i)
    expect(screen.getByText('Signed in.')).toBeTruthy()
  })
})
