import { describe, expect, it } from 'vitest'
import { actionSchema } from '../src/actions.js'

const parse = (action: unknown) => actionSchema.safeParse(action)
const reason = (action: unknown) => {
  const result = parse(action)
  expect(result.success, JSON.stringify(action)).toBe(false)
  return result.success ? '' : result.error.issues.map((i) => i.message).join('; ')
}

describe('webhook actions', () => {
  it('takes a URL and nothing else', () => {
    expect(parse({ type: 'webhook', url: 'https://example.com/hook' }).success).toBe(true)
  })

  it('takes a secret parameter, a signature header name and a delivery header name', () => {
    expect(
      parse({
        type: 'webhook',
        url: 'https://example.com/hook',
        secretParameter: '/blockwarden/webhook-secret',
        signatureHeader: 'Billwarden-Signature',
        deliveryHeader: 'Billwarden-Delivery',
      }).success,
    ).toBe(true)
  })

  it('refuses a URL the destination rules refuse', () => {
    expect(reason({ type: 'webhook', url: 'http://example.com/hook' })).toContain('must be https')
    expect(reason({ type: 'webhook', url: 'https://169.254.169.254/' })).toContain('169.254.0.0/16')
  })

  it('refuses a header name that is not a header name', () => {
    expect(reason({ type: 'webhook', url: 'https://e.com/h', signatureHeader: 'has space' })).toContain('header name')
    expect(reason({ type: 'webhook', url: 'https://e.com/h', signatureHeader: '' })).toContain('header name')
  })

  it('refuses a header name the request computes for itself, or that frames the message', () => {
    const url = 'https://e.com/h'
    for (const name of [
      'host',
      'Host',
      'content-length',
      'content-type',
      'user-agent',
      'connection',
      'keep-alive',
      'proxy-authorization',
      'proxy-connection',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'expect',
    ]) {
      expect(reason({ type: 'webhook', url, signatureHeader: name }), name).toContain('reserved')
      expect(reason({ type: 'webhook', url, deliveryHeader: name }), name).toContain('reserved')
    }
    expect(parse({ type: 'webhook', url, signatureHeader: 'X-Hostname' }).success).toBe(true)
  })

  it('refuses a secret parameter that is not an SSM parameter name', () => {
    expect(reason({ type: 'webhook', url: 'https://e.com/h', secretParameter: 'no-slash' })).toContain('/')
  })

  it('holds the secret parameter to what SSM accepts as a name', () => {
    const url = 'https://e.com/h'
    for (const secretParameter of ['/s', '/blockwarden/webhook-secret', `/${Array(15).fill('a').join('/')}`]) {
      expect(parse({ type: 'webhook', url, secretParameter }).success, secretParameter).toBe(true)
    }
    // a bare slash, an empty level, a trailing slash, a space, a sixteenth level and an over-long name
    for (const secretParameter of [
      '/',
      '/a//b',
      '/a/b/',
      '/a b',
      `/${Array(16).fill('a').join('/')}`,
      `/${'a'.repeat(1011)}`,
    ]) {
      expect(reason({ type: 'webhook', url, secretParameter }), secretParameter).toBeTruthy()
    }
  })

  it('refuses an unknown key, so a misspelt option is not silently ignored', () => {
    expect(reason({ type: 'webhook', url: 'https://e.com/h', secrets: 'x' })).toContain('Unrecognized key')
  })
})

describe('email actions', () => {
  it('takes one to five recipients and an optional subject', () => {
    expect(parse({ type: 'email', to: ['ops@example.com'] }).success).toBe(true)
    expect(parse({ type: 'email', to: ['a@example.com'], subject: 'Large transfer' }).success).toBe(true)
  })

  it('refuses no recipients, six recipients and text that is not an address', () => {
    expect(reason({ type: 'email', to: [] })).toBeTruthy()
    expect(reason({ type: 'email', to: Array(6).fill('a@example.com') })).toBeTruthy()
    expect(reason({ type: 'email', to: ['not an address'] })).toBeTruthy()
  })
})

describe('telegram actions', () => {
  it('takes a chat id, which may be negative for a group', () => {
    expect(parse({ type: 'telegram', chatId: '-1001234567890' }).success).toBe(true)
  })

  it('refuses a chat id that is not a whole number', () => {
    expect(reason({ type: 'telegram', chatId: '@channel' })).toContain('chat id')
  })
})

describe('relay actions', () => {
  it('takes the whole transaction, because a rule holds no code to build one', () => {
    expect(
      parse({
        type: 'relay',
        signerId: 'demo',
        chainId: 84532,
        to: '0x2222222222222222222222222222222222222222',
        data: '0xabcdef01',
        value: '0',
        gasLimit: '120000',
      }).success,
    ).toBe(true)
  })

  it('refuses a value or gas limit that is not a decimal string', () => {
    const base = { type: 'relay', signerId: 'd', chainId: 1, to: `0x${'2'.repeat(40)}`, data: '0x' }
    expect(reason({ ...base, value: '0x10' })).toBeTruthy()
    expect(reason({ ...base, gasLimit: '-1' })).toBeTruthy()
    expect(reason({ ...base, value: 1 })).toBeTruthy()
  })

  it('refuses calldata that is not hex', () => {
    expect(reason({ type: 'relay', signerId: 'd', chainId: 1, to: `0x${'2'.repeat(40)}`, data: 'abcd' })).toBeTruthy()
  })
})

describe('same-account actions', () => {
  it('takes a queue ARN and a function ARN', () => {
    expect(parse({ type: 'sqs', queueArn: 'arn:aws:sqs:us-east-1:111122223333:ingest' }).success).toBe(true)
    expect(
      parse({ type: 'lambda', functionArn: 'arn:aws:lambda:us-east-1:111122223333:function:ingest' }).success,
    ).toBe(true)
  })

  it('takes a qualified function ARN, which is a legitimate invoke target', () => {
    const fn = 'arn:aws:lambda:us-east-1:111122223333:function:ingest'
    for (const arn of [`${fn}:PROD`, `${fn}:1`, `${fn}:$LATEST`]) {
      expect(parse({ type: 'lambda', functionArn: arn }).success, arn).toBe(true)
    }
  })

  it('holds a function name to the 64 characters Lambda really allows', () => {
    const arn = (name: string) => `arn:aws:lambda:us-east-1:111122223333:function:${name}`
    expect(parse({ type: 'lambda', functionArn: arn('n'.repeat(64)) }).success).toBe(true)
    expect(reason({ type: 'lambda', functionArn: arn('n'.repeat(65)) })).toContain('Lambda function ARN')
  })

  it('refuses a qualifier that is not an alias or a version', () => {
    expect(
      reason({ type: 'lambda', functionArn: 'arn:aws:lambda:us-east-1:111122223333:function:ingest:a/b' }),
    ).toContain('Lambda function ARN')
  })

  it('refuses an ARN of the wrong service', () => {
    expect(reason({ type: 'sqs', queueArn: 'arn:aws:sns:us-east-1:111122223333:ingest' })).toContain('SQS queue ARN')
    expect(reason({ type: 'lambda', functionArn: 'arn:aws:sqs:us-east-1:111122223333:ingest' })).toContain(
      'Lambda function ARN',
    )
  })
})

describe('unknown channels', () => {
  it('are refused by name', () => {
    expect(reason({ type: 'slack', url: 'https://example.com' })).toBeTruthy()
    expect(reason({})).toBeTruthy()
  })
})
