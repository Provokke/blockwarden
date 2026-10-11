import { isIP } from 'node:net'

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string }

// RFC 1918, loopback, link-local (the instance metadata endpoint lives at 169.254.169.254), carrier-grade NAT,
// IETF protocol assignments, documentation, the 6to4 relay anycast prefix, benchmarking, multicast and the
// reserved space above it
export const PRIVATE_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

const MAX_URL_LENGTH = 2048

function toInt(address: string): number {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0) >>> 0
}

function inRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (toInt(address) & mask) >>> 0 === (toInt(base) & mask) >>> 0
}

// Every group is two bytes, except a trailing dotted quad, which is four and stands for two groups. Getting that
// wrong leaves ::ffff:127.0.0.1 eighteen bytes long and unclassified.
function toBytes(address: string): number[] {
  const zone = address.indexOf('%')
  const text = zone === -1 ? address : address.slice(0, zone)
  const [head = '', tail] = text.split('::')
  const groups = (part: string) => (part ? part.split(':') : [])
  const left = groups(head)
  const right = text.includes('::') ? groups(tail ?? '') : undefined
  const width = (group: string) => (group.includes('.') ? 2 : 1)
  const count = (gs: string[]) => gs.reduce((n, g) => n + width(g), 0)
  const parts = right === undefined ? left : [...left, ...Array(8 - count(left) - count(right)).fill('0'), ...right]
  const bytes: number[] = []
  for (const part of parts) {
    if (part.includes('.')) {
      for (const octet of part.split('.')) bytes.push(Number(octet))
      continue
    }
    const value = Number.parseInt(part || '0', 16)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes
}

export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address)
  if (family === 4) {
    for (const [base, bits] of PRIVATE_V4_RANGES) {
      if (inRange(address, base, bits)) return { allowed: false, reason: `the address is inside ${base}/${bits}` }
    }
    return { allowed: true }
  }
  if (family !== 6) return { allowed: false, reason: 'the address is not an IP address' }
  const bytes = toBytes(address)
  if (bytes.length !== 16) return { allowed: false, reason: 'the address is not an IP address' }
  const zeros = (n: number) => bytes.slice(0, n).every((b) => b === 0)
  // ::ffff:a.b.c.d is an ordinary IPv4 address wearing an IPv6 spelling, so it is judged as one
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return classifyAddress(bytes.slice(12).join('.'))
  // everything else in ::/64 is ::, ::1 or one of the deprecated embeddings, all of which reach a local network
  if (zeros(8)) return { allowed: false, reason: 'the address is inside ::/64' }
  const [a = 0, b = 0, c = 0, d = 0] = bytes
  if (a === 0x00 && b === 0x64 && c === 0xff && d === 0x9b) {
    return { allowed: false, reason: 'the address is inside 64:ff9b::/96' }
  }
  if ((a & 0xfe) === 0xfc) return { allowed: false, reason: 'the address is inside fc00::/7' }
  if (a === 0xfe && (b & 0xc0) === 0x80) return { allowed: false, reason: 'the address is inside fe80::/10' }
  if (a === 0xfe && (b & 0xc0) === 0xc0) return { allowed: false, reason: 'the address is inside fec0::/10' }
  if (a === 0xff) return { allowed: false, reason: 'the address is inside ff00::/8' }
  if (a === 0x20 && b === 0x01 && c === 0x00 && d === 0x00) {
    return { allowed: false, reason: 'the address is inside 2001::/32' }
  }
  if (a === 0x20 && b === 0x01 && c === 0x0d && d === 0xb8) {
    return { allowed: false, reason: 'the address is inside 2001:db8::/32' }
  }
  if (a === 0x20 && b === 0x02) return { allowed: false, reason: 'the address is inside 2002::/16' }
  return { allowed: true }
}

export function checkDestinationUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: `the URL is longer than ${MAX_URL_LENGTH} characters` }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'the URL cannot be parsed' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'the URL must be https' }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the URL must not carry a username or a password' }
  }
  // a client turns port 0 back into 443 without saying so, so the URL would not name the port it reaches
  if (url.port === '0') return { ok: false, reason: 'the URL must not use port 0' }
  // URL normalises 0x7f.1, 127.1 and 2130706433 to 127.0.0.1, so one check covers every spelling
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(host) !== 0) {
    const verdict = classifyAddress(host)
    if (!verdict.allowed) return { ok: false, reason: verdict.reason }
  }
  return { ok: true, url }
}
