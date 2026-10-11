import { describe, expect, it, vi } from 'vitest'
import { ssmSecrets } from '../../src/secrets.js'

const client = (value: string | undefined, fail?: Error) => {
  const send = vi.fn(async (_command: { input: unknown }) => {
    if (fail) throw fail
    return { Parameter: { Value: value } }
  })
  return { client: { send } as never, send }
}

describe('ssmSecrets', () => {
  it('splits a parameter on commas and trims each secret', async () => {
    const { client: c } = client(' new-secret , old-secret ')
    expect(await ssmSecrets(c).read('/bw/secret')).toEqual(['new-secret', 'old-secret'])
  })

  it('reads a parameter once inside its cache window and again after it', async () => {
    let now = 0
    const { client: c, send } = client('s')
    const secrets = ssmSecrets(c, { ttlMs: 1_000, now: () => now })
    await secrets.read('/bw/secret')
    await secrets.read('/bw/secret')
    expect(send).toHaveBeenCalledTimes(1)
    now = 1_001
    await secrets.read('/bw/secret')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('asks with decryption, because the parameter is a SecureString', async () => {
    const { client: c, send } = client('s')
    await ssmSecrets(c).read('/bw/secret')
    expect(send.mock.calls[0]![0].input).toEqual({ Name: '/bw/secret', WithDecryption: true })
  })

  it('refuses an empty parameter rather than signing with an empty secret', async () => {
    const { client: c } = client('  ,  ')
    await expect(ssmSecrets(c).read('/bw/secret')).rejects.toThrow('/bw/secret holds no secret')
  })

  it('forgets an expired parameter instead of holding its plaintext for the life of the container', async () => {
    let now = 0
    const { client: c } = client('s')
    const secrets = ssmSecrets(c, { ttlMs: 1_000, now: () => now })
    await secrets.read('/bw/a')
    expect(secrets.held).toBe(1)
    now = 1_001
    // /bw/a is never asked for again, so only a sweep on some other read can drop it
    await secrets.read('/bw/b')
    expect(secrets.held).toBe(1)
  })

  it('makes one call for concurrent cold reads of the same parameter', async () => {
    const { client: c, send } = client('s')
    const secrets = ssmSecrets(c)
    const answers = await Promise.all([secrets.read('/bw/s'), secrets.read('/bw/s'), secrets.read('/bw/s')])
    expect(send).toHaveBeenCalledTimes(1)
    expect(answers).toEqual([['s'], ['s'], ['s']])
  })

  it('does not hold a failed read in flight', async () => {
    const { client: c, send } = client(undefined, new Error('ThrottlingException'))
    const secrets = ssmSecrets(c)
    await expect(Promise.all([secrets.read('/bw/s'), secrets.read('/bw/s')])).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
    await expect(secrets.read('/bw/s')).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('hands out a copy, so a caller cannot rewrite what the next reader gets', async () => {
    const { client: c } = client('new-secret,old-secret')
    const secrets = ssmSecrets(c, { ttlMs: 1_000, now: () => 0 })
    const first = await secrets.read('/bw/secret')
    first.push('not-a-secret')
    first[0] = 'tampered'
    expect(await secrets.read('/bw/secret')).toEqual(['new-secret', 'old-secret'])
  })

  it('does not cache a failure', async () => {
    const { client: c, send } = client(undefined, new Error('ParameterNotFound'))
    const secrets = ssmSecrets(c, { ttlMs: 1_000, now: () => 0 })
    await expect(secrets.read('/bw/x')).rejects.toThrow()
    await expect(secrets.read('/bw/x')).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
