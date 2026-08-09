import { HttpRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import { redactData, redactError, redactUrls } from '../../src/redact.js'

const PATH_KEY = 'https://base-mainnet.g.example.com/v2/pathSecret123'
const QUERY_KEY = 'https://rpc.example.org/base?apikey=querySecret456'
const URLS = [PATH_KEY, QUERY_KEY]

describe('redactUrls', () => {
  it('replaces each configured URL with its index, with or without a trailing slash', () => {
    const text = [
      `URL: ${PATH_KEY}`,
      `URL: ${PATH_KEY}/`,
      `URL: ${QUERY_KEY}`,
      'URL: https://rpc.example.org/base',
      'URL: https://rpc.example.org/base/',
    ].join('\n')

    const redacted = redactUrls(text, URLS)

    expect(redacted).toBe(['URL: rpc[0]', 'URL: rpc[0]', 'URL: rpc[1]', 'URL: rpc[1]', 'URL: rpc[1]'].join('\n'))
  })

  it('replaces a URL configured with a trailing slash when the text has none', () => {
    expect(redactUrls(`at ${PATH_KEY} failed`, [`${PATH_KEY}/`])).toBe('at rpc[0] failed')
  })

  it('never leaves part of a longer key behind when one URL is a prefix of another', () => {
    const short = 'https://x.example.com/v2/key'
    const long = 'https://x.example.com/v2/key2'
    expect(redactUrls(`${long} ${short}`, [short, long])).toBe('rpc[1] rpc[0]')
  })
})

describe('redactError', () => {
  it('redacts the key from the message, every cause and the stack', () => {
    const root = new Error(`connect failed ${QUERY_KEY}`)
    const middle = new Error(`fetch failed at ${PATH_KEY}/`, { cause: root })
    const err = new Error(`HTTP request failed.\n\nURL: ${PATH_KEY}`, { cause: middle })

    const { message, stack } = redactError(err, URLS)

    for (const text of [message, stack]) {
      expect(text).not.toContain('pathSecret123')
      expect(text).not.toContain('querySecret456')
    }
    expect(message).toContain('URL: rpc[0]')
    expect(message).toContain('fetch failed at rpc[0]')
    expect(message).toContain('connect failed rpc[1]')
    expect(stack).toContain('URL: rpc[0]')
  })

  it('stops following causes after five levels, including a cycle', () => {
    const a = new Error('level a') as Error & { cause?: unknown }
    const b = new Error('level b', { cause: a })
    a.cause = b

    const { message } = redactError(a, URLS)

    expect(message.split('\n').filter((line) => line.startsWith('caused by:'))).toHaveLength(5)
  })

  it('redacts a URL with credentials and a query key from the form viem prints, without the credentials', () => {
    const configured = 'https://user:pass@node.example/path?apikey=SECRET'
    // viem moves the credentials into an Authorization header and prints the rest of the URL
    const printed = new URL(configured)
    printed.username = ''
    printed.password = ''
    const cause = new Error(`fetch failed for ${printed.toString()}`)
    const err = new HttpRequestError({ url: printed.toString(), body: { method: 'eth_getLogs' }, cause })
    expect(`${err.message}\n${err.stack}`).toContain('SECRET')

    const { message, stack } = redactError(err, [configured])

    for (const text of [message, stack]) {
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('pass')
    }
    expect(message).toContain('URL: rpc[0]')
  })

  it('handles a thrown value that is not an Error', () => {
    expect(redactError(`boom ${PATH_KEY}`, URLS).message).toBe('boom rpc[0]')
  })
})

describe('redactData', () => {
  it('redacts strings in nested objects, arrays and errors, and keeps other values', () => {
    const err = new Error(`fetch failed for ${QUERY_KEY}`)
    const data = {
      chainId: 8453,
      big: 7n,
      ok: true,
      url: PATH_KEY,
      nested: { urls: [PATH_KEY, { deeper: QUERY_KEY }], error: err },
    }

    const redacted = redactData(data, URLS) as Record<string, unknown>

    expect(JSON.stringify(redacted, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(
      /pathSecret123|querySecret456/,
    )
    expect(redacted).toMatchObject({
      chainId: 8453,
      big: 7n,
      ok: true,
      url: 'rpc[0]',
      nested: {
        urls: ['rpc[0]', { deeper: 'rpc[1]' }],
        error: { name: 'Error', message: 'fetch failed for rpc[1]' },
      },
    })
    const logged = (redacted.nested as { error: { stack: string } }).error.stack
    expect(logged).toContain('fetch failed for rpc[1]')
    expect(logged).not.toContain('querySecret456')
  })

  it('replaces anything nested deeper than five levels instead of logging it unredacted', () => {
    const data = { a: { b: { c: { d: { e: { f: { url: PATH_KEY } } } } } } }

    const text = JSON.stringify(redactData(data, URLS))

    expect(text).not.toContain('pathSecret123')
    expect(text).toContain('"e":{"f":"[nested too deep to log]"}')
  })
})
