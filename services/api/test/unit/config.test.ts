import { describe, expect, it } from 'vitest'
import { loadAuthorizerConfig, loadConfig, rpcUrlsFrom, sessionSecretFrom } from '../../src/config.js'

const wallet = '0x52908400098527886E0F7030069857D2E4169EE7'

const valid = {
  TABLE_NAME: 'blockwarden',
  SESSION_SECRET_PARAMETER: '/blockwarden/session-secret',
  DELIVERY_QUEUE_URL: 'https://sqs.eu-west-2.amazonaws.com/123456789012/blockwarden-deliveries',
  SITE_ORIGIN: 'https://demo.blockwarden.dev',
  SIWE_DOMAIN: 'demo.blockwarden.dev',
  ALLOWED_WALLETS: wallet,
  CHAINS: JSON.stringify([
    { chainId: 8453, rpcUrlsParameter: '/blockwarden/rpc/base' },
    { chainId: 42161, rpcUrlsParameter: '/blockwarden/rpc/arbitrum' },
  ]),
  RULE_SECRET_PREFIXES: '/blockwarden/rules',
}

function refusal(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('loadConfig accepted the environment')
}

describe('loadConfig', () => {
  it('loads a valid environment', () => {
    const config = loadConfig(valid)
    expect(config).toEqual({
      tableName: 'blockwarden',
      sessionSecretParameter: '/blockwarden/session-secret',
      deliveryQueueUrl: valid.DELIVERY_QUEUE_URL,
      siteOrigin: 'https://demo.blockwarden.dev',
      siweDomain: 'demo.blockwarden.dev',
      allowedWallets: [wallet],
      chains: [
        { chainId: 8453, rpcUrlsParameter: '/blockwarden/rpc/base' },
        { chainId: 42161, rpcUrlsParameter: '/blockwarden/rpc/arbitrum' },
      ],
      chainIds: [8453, 42161],
      ruleSecretPrefixes: ['/blockwarden/rules'],
    })
  })

  it('reads no rule secret prefixes when the variable is absent', () => {
    expect(loadConfig({ ...valid, RULE_SECRET_PREFIXES: undefined }).ruleSecretPrefixes).toEqual([])
  })

  it('stores allowed wallets checksummed, whatever case Terraform wrote them in', () => {
    const config = loadConfig({ ...valid, ALLOWED_WALLETS: ` ${wallet.toLowerCase()} , ${'0x' + 'ab'.repeat(20)}` })
    expect(config.allowedWallets).toEqual([wallet, '0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB'])
  })

  it.each([
    'TABLE_NAME',
    'SESSION_SECRET_PARAMETER',
    'DELIVERY_QUEUE_URL',
    'SITE_ORIGIN',
    'SIWE_DOMAIN',
    'ALLOWED_WALLETS',
    'CHAINS',
  ])('refuses an environment with no %s', (key) => {
    expect(refusal({ ...valid, [key]: undefined })).toContain(key)
  })

  it('refuses an allowlist that holds no wallet at all', () => {
    // an empty allowlist locks every operator out, and must not load as a quiet state
    expect(refusal({ ...valid, ALLOWED_WALLETS: ' , ' })).toContain('ALLOWED_WALLETS')
  })

  it('refuses a wallet that is not an address', () => {
    expect(refusal({ ...valid, ALLOWED_WALLETS: `${wallet},0x1234` })).toContain('ALLOWED_WALLETS')
  })

  it('refuses a wallet with a broken checksum rather than 500ing every login later', () => {
    const broken = wallet.replace('E0F', 'e0F')
    expect(refusal({ ...valid, ALLOWED_WALLETS: broken })).toContain('ALLOWED_WALLETS')
  })

  it('refuses a plain-http queue URL or site origin', () => {
    expect(refusal({ ...valid, DELIVERY_QUEUE_URL: 'http://sqs.local/q' })).toContain('DELIVERY_QUEUE_URL')
    expect(refusal({ ...valid, SITE_ORIGIN: 'http://demo.blockwarden.dev' })).toContain('SITE_ORIGIN')
  })

  it('refuses a site origin that carries a path', () => {
    expect(refusal({ ...valid, SITE_ORIGIN: 'https://demo.blockwarden.dev/app' })).toContain('SITE_ORIGIN')
  })

  it('refuses a SIWE domain that is not the site origin host', () => {
    const message = refusal({ ...valid, SIWE_DOMAIN: 'blockwarden.dev' })
    expect(message).toContain('SIWE_DOMAIN')
    expect(message).toContain('SITE_ORIGIN')
  })

  it('takes a port in the site origin as part of the SIWE domain', () => {
    const config = loadConfig({ ...valid, SITE_ORIGIN: 'https://localhost:8443', SIWE_DOMAIN: 'localhost:8443' })
    expect(config.siweDomain).toBe('localhost:8443')
  })

  it('refuses a session secret parameter that is not a parameter path', () => {
    expect(refusal({ ...valid, SESSION_SECRET_PARAMETER: 'session-secret' })).toContain('SESSION_SECRET_PARAMETER')
    expect(refusal({ ...valid, SESSION_SECRET_PARAMETER: '/bw/../other' })).toContain('SESSION_SECRET_PARAMETER')
  })

  it('refuses RULE_SECRET_PREFIXES=/, which would admit every parameter in the account', () => {
    expect(refusal({ ...valid, RULE_SECRET_PREFIXES: '/' })).toContain('RULE_SECRET_PREFIXES')
  })

  it('refuses a rule secret prefix that climbs a level or does not start with /', () => {
    expect(refusal({ ...valid, RULE_SECRET_PREFIXES: '/bw/rules,/bw/../x' })).toContain('RULE_SECRET_PREFIXES')
    expect(refusal({ ...valid, RULE_SECRET_PREFIXES: 'bw/rules' })).toContain('RULE_SECRET_PREFIXES')
  })

  it('refuses a TABLE_NAME too short to be a DynamoDB table', () => {
    expect(refusal({ ...valid, TABLE_NAME: 'ab' })).toContain('TABLE_NAME')
  })

  describe('CHAINS', () => {
    const chains = (value: unknown) => ({ ...valid, CHAINS: JSON.stringify(value) })

    it('refuses CHAINS that is not JSON without quoting what it was given', () => {
      const text = '[{"chainId": 1, "rpcUrlsParameter": "https://eth.example/v2/SECRETKEY"'
      const message = refusal({ ...valid, CHAINS: text })
      expect(message).toContain('CHAINS')
      expect(message).not.toContain('SECRETKEY')
    })

    it('refuses an empty list', () => {
      expect(refusal(chains([]))).toContain('CHAINS')
    })

    it('refuses a chain id that is not a positive integer', () => {
      for (const chainId of [0, -1, 1.5, '8453']) {
        expect(refusal(chains([{ chainId, rpcUrlsParameter: '/bw/rpc/base' }])), String(chainId)).toContain('CHAINS')
      }
    })

    it('refuses the same chain listed twice', () => {
      const message = refusal(
        chains([
          { chainId: 8453, rpcUrlsParameter: '/bw/rpc/base' },
          { chainId: 8453, rpcUrlsParameter: '/bw/rpc/base-2' },
        ]),
      )
      expect(message).toContain('CHAINS')
      expect(message).toContain('8453')
    })

    it('refuses a key it does not know rather than ignoring it', () => {
      expect(refusal(chains([{ chainId: 8453, rpcUrlsParameter: '/bw/rpc/base', rpcUrl: 'x' }]))).toContain('CHAINS')
    })

    it('refuses an RPC parameter that is not a parameter path, without echoing it', () => {
      const message = refusal(chains([{ chainId: 8453, rpcUrlsParameter: 'https://base.example/v2/SECRETKEY' }]))
      expect(message).toContain('CHAINS')
      expect(message).not.toContain('SECRETKEY')
    })

    it('refuses an RPC parameter of / or one with a .. level', () => {
      expect(refusal(chains([{ chainId: 8453, rpcUrlsParameter: '/' }]))).toContain('CHAINS')
      expect(refusal(chains([{ chainId: 8453, rpcUrlsParameter: '/bw/../rpc' }]))).toContain('CHAINS')
    })

    it('refuses a chain with no RPC parameter', () => {
      expect(refusal(chains([{ chainId: 8453 }]))).toContain('CHAINS')
    })
  })
})

describe('loadAuthorizerConfig', () => {
  it('needs only the table and the session secret parameter', () => {
    expect(
      loadAuthorizerConfig({ TABLE_NAME: 'blockwarden', SESSION_SECRET_PARAMETER: '/blockwarden/session-secret' }),
    ).toEqual({ tableName: 'blockwarden', sessionSecretParameter: '/blockwarden/session-secret' })
  })

  it('refuses a missing or malformed setting, naming it', () => {
    expect(() => loadAuthorizerConfig({ SESSION_SECRET_PARAMETER: '/bw/s' })).toThrow('TABLE_NAME')
    expect(() => loadAuthorizerConfig({ TABLE_NAME: 'blockwarden', SESSION_SECRET_PARAMETER: '/' })).toThrow(
      'SESSION_SECRET_PARAMETER',
    )
  })
})

describe('rpcUrlsFrom', () => {
  it('splits comma-separated URLs as the monitor and relayer store them', () => {
    expect(rpcUrlsFrom('/bw/rpc/base', ' https://a.example/k1 ,https://b.example/k2,')).toEqual([
      'https://a.example/k1',
      'https://b.example/k2',
    ])
  })

  it('names the parameter and never the value when it holds nothing usable', () => {
    expect(() => rpcUrlsFrom('/bw/rpc/base', ' , ')).toThrow('/bw/rpc/base')
    let message = ''
    try {
      rpcUrlsFrom('/bw/rpc/base', 'https://a.example/SECRETKEY,not a url')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('/bw/rpc/base')
    expect(message).not.toContain('SECRETKEY')
  })
})

describe('sessionSecretFrom', () => {
  it('uses the parameter value as the key bytes', () => {
    const value = 'k'.repeat(32)
    expect(sessionSecretFrom('/bw/session', value)).toEqual(new TextEncoder().encode(value))
  })

  it('refuses a secret shorter than an HS256 key should be, naming the parameter and not the value', () => {
    let message = ''
    try {
      sessionSecretFrom('/bw/session', 'short-SECRET')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('/bw/session')
    expect(message).not.toContain('short-SECRET')
  })
})
