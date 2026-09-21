import { z } from 'zod'
import type { Address, Hex } from 'viem'
import { checkDestinationUrl } from './net.js'

// the regex already proves the value is 0x-prefixed hex; the transform only carries that into the type so a
// relay action's to/data come out as viem's own Address/Hex instead of a plain string every caller has to cast
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
  .transform((value) => value as Address)
const hex = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, 'expected 0x followed by whole bytes of hex')
  .transform((value) => value as Hex)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected a decimal string')
// what the relayer's own policy caps calldata at (MAX_DATA_BYTES in services/relayer/src/policy.ts). Without
// the same cap here a rule stores calldata the relayer will refuse on every attempt until the delivery dies.
export const MAX_RELAY_DATA_BYTES = 8 * 1024
// No RFC caps a header name, but a server does, and two of these plus a payload have to fit in one DynamoDB
// item. 128 is longer than any header anyone sends and short enough that no action can be sized to break the
// item; parameterName is capped for the same reason.
export const MAX_HEADER_NAME_LENGTH = 128
// the headers the sender computes for itself, plus the ones that frame the message or steer the connection: a
// rule naming one of these would either be overwritten or break the delivery, and Host in particular decides
// which site a destination thinks it is serving
const RESERVED_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
])
// RFC 7230 token, which is what a header name is. Exported so a caller-facing schema outside a rule's own
// action (Task 12's outbound request) refuses the same names a webhook action would, rather than growing a
// second, looser idea of what a header name is.
export const headerName = z
  .string()
  .max(MAX_HEADER_NAME_LENGTH, `expected a header name of at most ${MAX_HEADER_NAME_LENGTH} characters`)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a header name')
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), 'expected a header name that is not reserved')
// SSM: a hierarchy of at most fifteen non-empty levels, each of a-zA-Z0-9_.-, and at most 1011 characters.
// Exported for the same reason headerName is: Task 12's outbound request lets a third party name this parameter,
// and that surface has to mean the same thing by a parameter name as a rule's own action does.
export const parameterName = z
  .string()
  .max(1011)
  .regex(/^(\/[A-Za-z0-9_.-]+){1,15}$/, 'expected an SSM parameter name starting with / and at most 15 levels deep')
  // nothing in the chain normalises a path: SSM reads the name literally and an IAM resource ARN matches it as
  // a string. A `..` level is therefore a real level with a misleading name, and refusing it keeps a prefix
  // check and the grant that mirrors it from ever disagreeing about which parameter is meant.
  .refine((name) => !name.split('/').includes('..'), 'expected a parameter name without a .. level')

const destination = z.string().superRefine((raw, ctx) => {
  const checked = checkDestinationUrl(raw)
  if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason })
})

// what the sender calls the two headers when a rule names neither. @blockwarden/relayer-client exports the same
// pair as SIGNATURE_HEADER/DELIVERY_HEADER, and docs/webhooks/v1.md publishes them.
export const DEFAULT_SIGNATURE_HEADER = 'x-blockwarden-signature'
export const DEFAULT_DELIVERY_HEADER = 'x-blockwarden-delivery'

export const webhookActionSchema = z
  .strictObject({
    type: z.literal('webhook'),
    url: destination,
    // several comma-separated secrets may sit in one parameter while one is being rotated
    secretParameter: parameterName.optional(),
    signatureHeader: headerName.optional(),
    deliveryHeader: headerName.optional(),
  })
  // one name for both headers means one of them wins and the other is never sent; if the signature is the one
  // that loses, the request goes out unsigned. A name that is left out still counts, because the sender falls
  // back to its default, and the comparison is case-insensitive because a header name is.
  .refine(
    (action) =>
      (action.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase() !==
      (action.deliveryHeader ?? DEFAULT_DELIVERY_HEADER).toLowerCase(),
    'expected the signature and delivery headers to be different headers, not the same header twice',
  )

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
  data: hex.refine(
    (value) => (value.length - 2) / 2 <= MAX_RELAY_DATA_BYTES,
    `expected calldata of at most ${MAX_RELAY_DATA_BYTES} bytes`,
  ),
  value: decimal.optional(),
  gasLimit: decimal.optional(),
})

export const sqsActionSchema = z.strictObject({
  type: z.literal('sqs'),
  // an SQS queue name is at most 80 characters and ".fifo" is part of it, so a FIFO name has 75 left. The
  // sender sets a group and deduplication id for a .fifo queue, and config.ts's allowlist takes the same shape.
  queueArn: z.string().regex(/^arn:aws[a-z-]*:sqs:[a-z0-9-]+:\d{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/, {
    message: 'expected an SQS queue ARN',
  }),
})

export const lambdaActionSchema = z.strictObject({
  type: z.literal('lambda'),
  // a function name is at most 64 characters, and the ARN may carry an alias or a version to invoke
  functionArn: z
    .string()
    .regex(
      /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}(:(\$LATEST|[A-Za-z0-9_-]{1,128}))?$/,
      {
        message: 'expected a Lambda function ARN',
      },
    ),
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
