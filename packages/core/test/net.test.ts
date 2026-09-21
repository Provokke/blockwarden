import { describe, expect, it } from 'vitest'
import { checkDestinationUrl, classifyAddress } from '../src/net.js'

const refused = (address: string) => {
  const verdict = classifyAddress(address)
  expect(verdict.allowed, `${address} should be refused`).toBe(false)
  return verdict.allowed ? '' : verdict.reason
}

describe('classifyAddress', () => {
  it('allows an ordinary public address', () => {
    expect(classifyAddress('8.8.8.8')).toEqual({ allowed: true })
    expect(classifyAddress('2606:4700::1111')).toEqual({ allowed: true })
  })

  it('refuses every private and reserved IPv4 range', () => {
    expect(refused('0.0.0.0')).toContain('0.0.0.0/8')
    expect(refused('10.1.2.3')).toContain('10.0.0.0/8')
    expect(refused('100.64.0.1')).toContain('100.64.0.0/10')
    expect(refused('127.0.0.1')).toContain('127.0.0.0/8')
    expect(refused('169.254.169.254')).toContain('169.254.0.0/16')
    expect(refused('172.16.0.1')).toContain('172.16.0.0/12')
    expect(refused('172.31.255.255')).toContain('172.16.0.0/12')
    expect(refused('192.0.0.1')).toContain('192.0.0.0/24')
    expect(refused('192.168.1.1')).toContain('192.168.0.0/16')
    expect(refused('192.88.99.1')).toContain('192.88.99.0/24')
    expect(refused('198.18.0.1')).toContain('198.18.0.0/15')
    expect(refused('224.0.0.1')).toContain('224.0.0.0/4')
    expect(refused('240.0.0.1')).toContain('240.0.0.0/4')
  })

  it('masks a range that does not end on a byte, at both of its edges', () => {
    expect(refused('100.127.255.255')).toContain('100.64.0.0/10')
    expect(classifyAddress('100.128.0.0')).toEqual({ allowed: true })
    expect(refused('172.31.255.255')).toContain('172.16.0.0/12')
    expect(refused('198.19.255.255')).toContain('198.18.0.0/15')
    expect(classifyAddress('198.20.0.0')).toEqual({ allowed: true })
  })

  it('does not refuse an address just outside a range', () => {
    for (const address of ['100.128.0.1', '169.253.0.1', '172.15.0.1', '172.32.0.1', '198.17.0.1', '198.20.0.1']) {
      expect(classifyAddress(address), address).toEqual({ allowed: true })
    }
  })

  it('refuses the IPv4-mapped form of a refused address and allows the mapped form of a public one', () => {
    expect(refused('::ffff:127.0.0.1')).toContain('127.0.0.0/8')
    expect(refused('::ffff:169.254.169.254')).toContain('169.254.0.0/16')
    expect(refused('::ffff:7f00:1')).toContain('127.0.0.0/8')
    expect(classifyAddress('::ffff:8.8.8.8')).toEqual({ allowed: true })
  })

  it('refuses everything else inside ::/64, which is where the old embedding forms live', () => {
    for (const address of ['::1', '::', '::127.0.0.1', '::ffff:0:127.0.0.1', '::ffff:0:8.8.8.8']) {
      expect(refused(address)).toContain('::/64')
    }
  })

  it('refuses the IPv6 ranges that reach a local or translated network', () => {
    expect(refused('fc00::1')).toContain('fc00::/7')
    expect(refused('fd00::1')).toContain('fc00::/7')
    expect(refused('fe80::1')).toContain('fe80::/10')
    expect(refused('fe80::1%eth0')).toContain('fe80::/10')
    expect(refused('fec0::1')).toContain('fec0::/10')
    expect(refused('ff02::1')).toContain('ff00::/8')
    expect(refused('64:ff9b::7f00:1')).toContain('64:ff9b::/96')
    expect(refused('2002:7f00:1::1')).toContain('2002::/16')
    expect(refused('2001:0:53aa::1')).toContain('2001::/32')
    expect(refused('2001:db8::1')).toContain('2001:db8::/32')
  })

  it('refuses text that is not an address at all', () => {
    expect(refused('example.com')).toContain('not an IP address')
    expect(refused('')).toContain('not an IP address')
  })
})

describe('checkDestinationUrl', () => {
  it('accepts an ordinary https URL and keeps its path and query', () => {
    const checked = checkDestinationUrl('https://example.com/hook?x=1')
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.url.pathname + checked.url.search).toBe('/hook?x=1')
  })

  it('accepts a public IPv4 literal', () => {
    expect(checkDestinationUrl('https://8.8.8.8/hook').ok).toBe(true)
  })

  it('refuses a scheme other than https', () => {
    expect(checkDestinationUrl('http://example.com/hook')).toEqual({ ok: false, reason: 'the URL must be https' })
    expect(checkDestinationUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'the URL must be https' })
  })

  it('refuses credentials, which a redirect or a log would carry', () => {
    expect(checkDestinationUrl('https://user:pw@example.com/hook')).toEqual({
      ok: false,
      reason: 'the URL must not carry a username or a password',
    })
  })

  it('refuses a literal address inside a refused range, in every spelling', () => {
    for (const raw of [
      'https://127.0.0.1/hook',
      'https://127.1/hook',
      'https://2130706433/hook',
      'https://0x7f.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[fd00::1]/hook',
    ]) {
      expect(checkDestinationUrl(raw).ok, raw).toBe(false)
    }
  })

  it('refuses port 0, which a client silently turns back into 443', () => {
    expect(checkDestinationUrl('https://example.com:0/hook')).toEqual({
      ok: false,
      reason: 'the URL must not use port 0',
    })
    expect(checkDestinationUrl('https://example.com:8443/hook').ok).toBe(true)
  })

  it('refuses something that is not a URL', () => {
    expect(checkDestinationUrl('not a url')).toEqual({ ok: false, reason: 'the URL cannot be parsed' })
  })

  it('refuses a URL longer than 2048 characters', () => {
    expect(checkDestinationUrl(`https://example.com/${'a'.repeat(2048)}`).ok).toBe(false)
  })
})
