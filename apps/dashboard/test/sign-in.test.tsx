import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { parseSiweMessage } from 'viem/siwe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const wallet = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, chainId: undefined as number | undefined },
  sign: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: () => ({
    address: wallet.account.address,
    chainId: wallet.account.chainId,
    isConnected: wallet.account.address !== undefined,
  }),
  useSignMessage: () => ({ mutateAsync: wallet.sign }),
}))

const { SignIn } = await import('../src/components/SignIn.js')

type Call = { path: string; method: string; body: unknown }
let calls: Call[]
let nonces: string[]
let verifyResponse: () => Response

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function signedMessage(index = 0): string {
  return (wallet.sign.mock.calls[index]![0] as { message: string }).message
}

// the two shapes a wallet rejection arrives in, each without the other's marker
const rejections = {
  'by name': () => Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' }),
  'by EIP-1193 code': () => Object.assign(new Error('denied'), { code: 4001 }),
  'wrapped as a cause': () => new Error('wrapper', { cause: Object.assign(new Error('denied'), { code: 4001 }) }),
}
const rejection = rejections['by name']

beforeEach(() => {
  calls = []
  nonces = ['nonce0001aaaa', 'nonce0002bbbb', 'nonce0003cccc']
  verifyResponse = () => json(200, { address: ADDRESS })
  wallet.account.address = ADDRESS
  wallet.account.chainId = 8453
  wallet.sign.mockReset()
  // the signature depends on the message, so a test can tell which message was signed
  wallet.sign.mockImplementation(async ({ message }: { message: string }) => `0xsig:${message}`)
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: input, method, body })
    if (method === 'POST' && input === '/v1/auth/siwe/nonce') return json(200, { nonce: nonces.shift() })
    if (method === 'POST' && input === '/v1/auth/siwe/verify') return verifyResponse()
    return json(404, { error: { code: 'not_found', message: 'no such route' } })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SignIn', () => {
  it('does not render the sign-in button until a wallet is connected', () => {
    wallet.account.address = undefined
    wallet.account.chainId = undefined
    render(<SignIn onSignedIn={() => {}} />)
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })

  it('asks the API for a nonce, signs the message it built, and posts both', async () => {
    const onSignedIn = vi.fn()
    render(<SignIn onSignedIn={onSignedIn} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/auth/siwe/nonce', 'POST /v1/auth/siwe/verify'])
    expect(calls[1]!.body).toEqual({ message: signedMessage(), signature: `0xsig:${signedMessage()}` })
    const posted = calls[1]!.body as { message: string; signature: string }
    expect(posted.signature).toBe(`0xsig:${posted.message}`)
    const parsed = parseSiweMessage(signedMessage())
    expect(parsed.address).toBe(ADDRESS)
    expect(parsed.chainId).toBe(8453)
  })

  it('puts the nonce it was given into the message it signs and posts', async () => {
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(parseSiweMessage(signedMessage()).nonce).toBe('nonce0001aaaa')
    expect((calls[1]!.body as { message: string }).message).toContain('nonce0001aaaa')
  })

  it('carries an expiry, because the API refuses a message without one', async () => {
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(wallet.sign).toHaveBeenCalled())
    const ahead = parseSiweMessage(signedMessage()).expirationTime!.getTime() - Date.now()
    expect(ahead).toBeGreaterThan(0)
    expect(ahead).toBeLessThanOrEqual(300_000)
  })

  it('sets the message domain and uri from window.location, not from a constant', async () => {
    vi.stubGlobal('location', { host: 'demo.blockwarden.example', origin: 'https://demo.blockwarden.example' })
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(wallet.sign).toHaveBeenCalled())
    const parsed = parseSiweMessage(signedMessage())
    expect(parsed.domain).toBe('demo.blockwarden.example')
    expect(parsed.uri).toBe('https://demo.blockwarden.example')
  })

  it('keeps the port in the domain, which is what the dev proxy serves from', async () => {
    vi.stubGlobal('location', { host: 'localhost:3100', origin: 'http://localhost:3100' })
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(wallet.sign).toHaveBeenCalled())
    const parsed = parseSiweMessage(signedMessage())
    expect(parsed.domain).toBe('localhost:3100')
    expect(parsed.uri).toBe('http://localhost:3100')
  })

  it('shows the API refusal message when the wallet is not on the allowlist', async () => {
    verifyResponse = () =>
      json(401, { error: { code: 'siwe_wallet', message: 'that wallet may not sign in to this deployment' } })
    const onSignedIn = vi.fn()
    render(<SignIn onSignedIn={onSignedIn} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('that wallet may not sign in to this deployment')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('shows a retryable message when the user rejects the signature, and does not post', async () => {
    wallet.sign.mockRejectedValueOnce(rejection())
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled|rejected|try again/i)
    expect(calls.map((c) => c.path)).toEqual(['/v1/auth/siwe/nonce'])
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
  })

  it.each(Object.entries(rejections))('treats a wallet rejection %s as retryable', async (_form, make) => {
    wallet.sign.mockRejectedValueOnce(make())
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/i)
    expect(calls.map((c) => c.path)).toEqual(['/v1/auth/siwe/nonce'])
  })

  it('does not offer sign-in on a chain the deployment does not monitor', () => {
    wallet.account.chainId = 137
    render(<SignIn onSignedIn={() => {}} />)
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
    expect(calls).toEqual([])
  })

  it('shows the wallet shortMessage for an unexpected error and logs the error', async () => {
    const failure = Object.assign(new Error('long detail'), { shortMessage: 'The wallet is locked.' })
    wallet.sign.mockRejectedValueOnce(failure)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('The wallet is locked.')
    expect(logged).toHaveBeenCalledWith(expect.anything(), failure)
    logged.mockRestore()
  })

  it('asks for a fresh nonce on a retry rather than reusing the spent one', async () => {
    wallet.sign.mockRejectedValueOnce(rejection())
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/auth/siwe/verify')).toHaveLength(1))

    expect(calls.filter((c) => c.path === '/v1/auth/siwe/nonce')).toHaveLength(2)
    expect(parseSiweMessage(signedMessage(1)).nonce).toBe('nonce0002bbbb')
    expect((calls.at(-1)!.body as { message: string }).message).toContain('nonce0002bbbb')
  })

  it('does not sign when the nonce request fails', async () => {
    vi.stubGlobal('fetch', async () => json(500, { error: { code: 'internal', message: 'the API failed' } }))
    render(<SignIn onSignedIn={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('the API failed')
    expect(wallet.sign).not.toHaveBeenCalled()
  })
})
