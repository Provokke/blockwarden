import { describe, expect, it } from 'vitest'
import { DestinationError, resolveDestination, type Resolver } from '../../src/destination.js'

const answers =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

const refused = async (raw: string, resolve?: Resolver) => {
  await expect(resolveDestination(raw, resolve ?? answers('93.184.216.34'))).rejects.toBeInstanceOf(DestinationError)
  return resolveDestination(raw, resolve ?? answers('93.184.216.34')).catch((e: Error) => e.message)
}

describe('the URL rules', () => {
  it('accepts an https URL and pins the address it checked', async () => {
    const target = await resolveDestination('https://example.com/hook?a=1', answers('93.184.216.34'))
    expect(target.host).toBe('example.com')
    expect(target.address).toBe('93.184.216.34')
    expect(target.family).toBe(4)
    expect(target.port).toBe(443)
    expect(target.url.pathname + target.url.search).toBe('/hook?a=1')
  })

  it('keeps an explicit port', async () => {
    expect((await resolveDestination('https://example.com:8443/h', answers('93.184.216.34'))).port).toBe(8443)
  })

  it('refuses http, credentials and anything unparseable', async () => {
    expect(await refused('http://example.com/hook')).toContain('https')
    expect(await refused('https://u:p@example.com/hook')).toContain('username')
    expect(await refused('nonsense')).toContain('cannot be parsed')
  })

  it('refuses a literal address in a refused range without asking the resolver', async () => {
    const never: Resolver = async () => {
      throw new Error('the resolver must not be called')
    }
    expect(await refused('https://127.0.0.1/hook', never)).toContain('127.0.0.0/8')
    expect(await refused('https://169.254.169.254/latest/meta-data/', never)).toContain('169.254.0.0/16')
    expect(await refused('https://[::1]/hook', never)).toContain('::/64')
  })
})

describe('resolution', () => {
  it('refuses a host that resolves to a private address', async () => {
    expect(await refused('https://internal.example.com/hook', answers('10.0.0.5'))).toContain('10.0.0.0/8')
  })

  it('refuses a host that resolves to a public and a private address', async () => {
    expect(await refused('https://mixed.example.com/hook', answers('93.184.216.34', '192.168.1.1'))).toContain(
      '192.168.0.0/16',
    )
  })

  it('refuses a host that resolves to nothing', async () => {
    expect(await refused('https://nowhere.example.com/hook', async () => [])).toContain('does not resolve')
  })

  it('turns a resolver failure into a destination error that may be retried', async () => {
    const broken: Resolver = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example.com'), { code: 'ENOTFOUND' })
    }
    expect(await refused('https://nowhere.example.com/hook', broken)).toContain('could not be resolved')
    const thrown = await resolveDestination('https://nowhere.example.com/hook', broken).catch(
      (e: DestinationError) => e,
    )
    expect((thrown as DestinationError).retryable).toBe(true)
  })

  it('marks a refused range as not worth retrying', async () => {
    const thrown = await resolveDestination('https://x.example.com/hook', answers('10.0.0.5')).catch(
      (e: DestinationError) => e,
    )
    expect((thrown as DestinationError).retryable).toBe(false)
  })

  it('pins the first address, and an IPv6 host keeps its family', async () => {
    const target = await resolveDestination('https://v6.example.com/h', answers('2606:4700::1111'))
    expect(target.address).toBe('2606:4700::1111')
    expect(target.family).toBe(6)
  })
})
