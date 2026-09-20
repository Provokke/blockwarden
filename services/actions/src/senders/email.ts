import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2'
import { truncate } from '../records.js'
import { summarise } from './render-text.js'
import type { Sender } from './types.js'

// SES refuses these for good, so a retry only burns attempts
const PERMANENT = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'BadRequestException',
  'NotFoundException',
])

export const sendEmail: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'email') throw new Error(`delivery ${delivery.deliveryId} is not an email`)
  if (!deps.ses || !deps.fromAddress) {
    return { kind: 'permanent', error: 'no SES sender address is configured' }
  }
  const { subject, text, html } = summarise(delivery.payload)
  try {
    await deps.ses.send(
      new SendEmailCommand({
        FromEmailAddress: deps.fromAddress,
        Destination: { ToAddresses: delivery.target.to },
        Content: {
          Simple: {
            Subject: { Data: delivery.target.subject ?? subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
          },
        },
        ...(deps.configurationSet ? { ConfigurationSetName: deps.configurationSet } : {}),
      }),
    )
    return { kind: 'delivered' }
  } catch (err) {
    const name = (err as Error).name
    const message = truncate(`SES refused the message (${name}): ${(err as Error).message}`)
    // throttling and a 5xx are worth another attempt; a rejected address is not
    return PERMANENT.has(name) ? { kind: 'permanent', error: message } : { kind: 'retry', error: message }
  }
}
