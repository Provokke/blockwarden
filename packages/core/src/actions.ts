import { z } from 'zod'
import { checkDestinationUrl } from './net.js'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'expected 0x followed by whole bytes of hex')
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected a decimal string')
// RFC 7230 token, which is what a header name is
const headerName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a header name')
const parameterName = z.string().startsWith('/', 'expected an SSM parameter name starting with /').max(1011)

const destination = z.string().superRefine((raw, ctx) => {
  const checked = checkDestinationUrl(raw)
  if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason })
})

export const webhookActionSchema = z.strictObject({
  type: z.literal('webhook'),
  url: destination,
  // several comma-separated secrets may sit in one parameter while one is being rotated
  secretParameter: parameterName.optional(),
  signatureHeader: headerName.optional(),
  deliveryHeader: headerName.optional(),
})

export const emailActionSchema = z.strictObject({
  type: z.literal('email'),
  to: z.array(z.email()).min(1).max(5),
  subject: z.string().min(1).max(120).optional(),
})

export const telegramActionSchema = z.strictObject({
  type: z.literal('telegram'),
  // Telegram's own chat id; a @name is not accepted because it can be re-registered by someone else
  chatId: z.string().regex(/^-?[1-9][0-9]{0,18}$/, 'expected a Telegram chat id'),
})

export const relayActionSchema = z.strictObject({
  type: z.literal('relay'),
  signerId: z.string().min(1).max(64),
  chainId: z.number().int().positive(),
  to: address,
  data: hex,
  value: decimal.optional(),
  gasLimit: decimal.optional(),
})

export const sqsActionSchema = z.strictObject({
  type: z.literal('sqs'),
  queueArn: z.string().regex(/^arn:aws[a-z-]*:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}(\.fifo)?$/, {
    message: 'expected an SQS queue ARN',
  }),
})

export const lambdaActionSchema = z.strictObject({
  type: z.literal('lambda'),
  functionArn: z.string().regex(/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,140}$/, {
    message: 'expected a Lambda function ARN',
  }),
})

export const actionSchema = z.discriminatedUnion('type', [
  webhookActionSchema,
  emailActionSchema,
  telegramActionSchema,
  relayActionSchema,
  sqsActionSchema,
  lambdaActionSchema,
])

export type ActionInput = z.infer<typeof actionSchema>
export type ActionType = ActionInput['type']
