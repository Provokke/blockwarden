import { InvokeCommand } from '@aws-sdk/client-lambda'
import { SendMessageCommand } from '@aws-sdk/client-sqs'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

// AWS answers these the same way however often it is asked
const PERMANENT = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'ResourceNotFoundException',
  'QueueDoesNotExist',
  'InvalidParameterValueException',
  'InvalidParameterValue',
  'RequestEntityTooLargeException',
  'InvalidMessageContents',
  'UnrecognizedClientException',
])

export function queueUrlFromArn(arn: string, region: string): string {
  const [, , , arnRegion, accountId, name] = arn.split(':')
  if (arnRegion !== region) throw new Error(`queue ${arn} is in another region than this function`)
  return `https://sqs.${arnRegion}.amazonaws.com/${accountId}/${name}`
}

function allowed(deps: { allowedTargetArns?: readonly string[] }, arn: string): boolean {
  return (deps.allowedTargetArns ?? []).includes(arn)
}

function refuse(arn: string): SendOutcome {
  // the IAM policy grants the same list, so this is the readable half of a check AWS also makes
  return { kind: 'permanent', error: `${arn} is not an allowed delivery target` }
}

function fromAwsError(err: unknown): SendOutcome {
  const name = (err as Error).name
  const message = truncate(`the target refused the delivery (${name}): ${(err as Error).message}`)
  return PERMANENT.has(name) ? { kind: 'permanent', error: message } : { kind: 'retry', error: message }
}

export const sendSqs: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'sqs') throw new Error(`delivery ${delivery.deliveryId} is not an SQS delivery`)
  const { queueArn } = delivery.target
  if (!deps.sqs || !deps.region) return { kind: 'permanent', error: 'no SQS client is configured' }
  if (!allowed(deps, queueArn)) return refuse(queueArn)
  try {
    await deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrlFromArn(queueArn, deps.region),
        MessageBody: delivery.payload,
        MessageAttributes: {
          deliveryId: { DataType: 'String', StringValue: delivery.deliveryId },
          type: { DataType: 'String', StringValue: delivery.event },
        },
        // a FIFO queue needs both; the subject keeps one match's events in order and the id deduplicates a retry
        ...(queueArn.endsWith('.fifo')
          ? { MessageGroupId: delivery.subject, MessageDeduplicationId: delivery.deliveryId }
          : {}),
      }),
    )
    return { kind: 'delivered' }
  } catch (err) {
    return fromAwsError(err)
  }
}

export const sendLambda: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'lambda') throw new Error(`delivery ${delivery.deliveryId} is not a Lambda delivery`)
  const { functionArn } = delivery.target
  if (!deps.lambda) return { kind: 'permanent', error: 'no Lambda client is configured' }
  if (!allowed(deps, functionArn)) return refuse(functionArn)
  try {
    const answer = await deps.lambda.send(
      new InvokeCommand({
        FunctionName: functionArn,
        // the answer is what makes a failure visible here rather than in the target's own dead-letter queue
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(delivery.payload),
      }),
    )
    if (answer.FunctionError) {
      const body = answer.Payload ? new TextDecoder().decode(answer.Payload) : ''
      return { kind: 'retry', error: truncate(`the function failed (${answer.FunctionError}): ${body}`) }
    }
    return { kind: 'delivered', ...(answer.StatusCode === undefined ? {} : { statusCode: answer.StatusCode }) }
  } catch (err) {
    return fromAwsError(err)
  }
}
