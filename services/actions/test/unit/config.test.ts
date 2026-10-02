import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const base = {
  TABLE_NAME: 'blockwarden',
  DELIVERY_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/deliveries',
  DELIVERY_DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/deliveries-dlq',
  AWS_REGION: 'us-east-1',
}

describe('loadConfig', () => {
  it('takes the three names it cannot work without', () => {
    expect(loadConfig(base)).toMatchObject({
      tableName: 'blockwarden',
      deliveryQueueUrl: base.DELIVERY_QUEUE_URL,
      deliveryDlqUrl: base.DELIVERY_DLQ_URL,
      region: 'us-east-1',
    })
  })

  it('says which one is missing', () => {
    for (const key of ['TABLE_NAME', 'DELIVERY_QUEUE_URL', 'DELIVERY_DLQ_URL', 'AWS_REGION']) {
      const env = { ...base, [key]: undefined }
      expect(() => loadConfig(env), key).toThrow(`${key} is required`)
    }
  })

  it('leaves every channel that is not configured switched off', () => {
    const config = loadConfig(base)
    expect(config.fromAddress).toBeUndefined()
    expect(config.telegramTokenParameter).toBeUndefined()
    expect(config.relayerApiUrl).toBeUndefined()
    expect(config.allowedTargetArns).toEqual([])
    expect(config.outboundSecretPrefixes).toEqual([])
  })

  it('splits the lists on commas and drops the blanks', () => {
    const config = loadConfig({
      ...base,
      ALLOWED_TARGET_ARNS: 'arn:aws:sqs:us-east-1:111122223333:a, ,arn:aws:lambda:us-east-1:111122223333:function:b',
      OUTBOUND_SECRET_PREFIXES: '/billwarden/, /gaswarden/',
    })
    expect(config.allowedTargetArns).toEqual([
      'arn:aws:sqs:us-east-1:111122223333:a',
      'arn:aws:lambda:us-east-1:111122223333:function:b',
    ])
    expect(config.outboundSecretPrefixes).toEqual(['/billwarden/', '/gaswarden/'])
  })

  it('refuses a secret prefix that does not start with a slash', () => {
    expect(() => loadConfig({ ...base, OUTBOUND_SECRET_PREFIXES: 'billwarden/' })).toThrow('must start with /')
  })

  it('refuses a relayer URL without a key parameter, and the other way round', () => {
    expect(() => loadConfig({ ...base, RELAYER_API_URL: 'https://api.example.com' })).toThrow(
      'RELAYER_API_KEY_PARAMETER',
    )
    expect(() => loadConfig({ ...base, RELAYER_API_KEY_PARAMETER: '/bw/key' })).toThrow('RELAYER_API_URL')
  })

  it('takes a reaper limit and refuses a silly one', () => {
    expect(loadConfig({ ...base, REAPER_LIMIT: '50' }).reaperLimit).toBe(50)
    expect(loadConfig(base).reaperLimit).toBe(100)
    expect(() => loadConfig({ ...base, REAPER_LIMIT: '0' })).toThrow('REAPER_LIMIT')
  })

  it('refuses a queue URL that is not a URL, at load rather than at the first delivery', () => {
    expect(() => loadConfig({ ...base, DELIVERY_QUEUE_URL: 'deliveries' })).toThrow('DELIVERY_QUEUE_URL')
    expect(() => loadConfig({ ...base, DELIVERY_DLQ_URL: 'sqs.us-east-1.amazonaws.com/1/dlq' })).toThrow(
      'DELIVERY_DLQ_URL',
    )
  })

  it('refuses a target ARN that is not an SQS queue or a Lambda function', () => {
    for (const arn of ['not-an-arn', 'arn:aws:sns:us-east-1:111122223333:topic', 'arn:aws:sqs:us-east-1:1112:a:b']) {
      expect(() => loadConfig({ ...base, ALLOWED_TARGET_ARNS: arn }), arn).toThrow('ALLOWED_TARGET_ARNS')
    }
  })

  it('refuses a secret parameter that SSM would not accept', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET_PARAMETER: 'bw/webhook' })).toThrow('WEBHOOK_SECRET_PARAMETER')
    expect(() => loadConfig({ ...base, TELEGRAM_TOKEN_PARAMETER: '/bw/telegram token' })).toThrow(
      'TELEGRAM_TOKEN_PARAMETER',
    )
    expect(() =>
      loadConfig({ ...base, RELAYER_API_URL: 'https://api.example.com', RELAYER_API_KEY_PARAMETER: 'bw/key' }),
    ).toThrow('RELAYER_API_KEY_PARAMETER')
  })

  it('refuses a relayer URL that is not a URL', () => {
    expect(() =>
      loadConfig({ ...base, RELAYER_API_URL: 'api.example.com', RELAYER_API_KEY_PARAMETER: '/bw/key' }),
    ).toThrow('RELAYER_API_URL')
  })

  it('refuses a secret prefix that names no level, so a lone slash cannot open every parameter', () => {
    for (const prefixes of ['/', '//', '/ ']) {
      expect(() => loadConfig({ ...base, OUTBOUND_SECRET_PREFIXES: prefixes }), prefixes).toThrow(
        'OUTBOUND_SECRET_PREFIXES',
      )
    }
  })

  it('takes a secret prefix with or without its trailing slash', () => {
    expect(
      loadConfig({ ...base, OUTBOUND_SECRET_PREFIXES: '/billwarden/, /gaswarden' }).outboundSecretPrefixes,
    ).toEqual(['/billwarden/', '/gaswarden'])
  })
})
