import { InvokeCommand } from '@aws-sdk/client-lambda'
import { SendMessageCommand } from '@aws-sdk/client-sqs'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

// AWS answers these the same way however often it is asked. Sourced against the installed SDKs rather than
// guessed AWS vocabulary:
//   - AccessDeniedException, UnrecognizedClientException: not modeled by either service - they come from the
//     shared authentication/authorization front door every AWS API sits behind (a bad signature or a denied
//     IAM policy), so no @aws-sdk/client-* package exports a class for them
//   - ResourceNotFoundException, QueueDoesNotExist, InvalidMessageContents, InvalidAddress, InvalidSecurity,
//     UnsupportedOperation, and the Kms* family: @aws-sdk/client-sqs@3.1131.0, dist-types/models/errors.d.ts
//   - InvalidParameterValueException, RequestTooLargeException, and the KMS* family: @aws-sdk/client-lambda@
//     3.1131.0, dist-types/models/errors.d.ts (note the different capitalisation of "KMS" from SQS's "Kms")
const PERMANENT = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ResourceNotFoundException',
  'QueueDoesNotExist',
  'InvalidMessageContents',
  'InvalidAddress',
  'InvalidSecurity',
  'UnsupportedOperation',
  'InvalidParameterValueException',
  'RequestTooLargeException',
  'KmsAccessDenied',
  'KmsDisabled',
  'KmsInvalidKeyUsage',
  'KmsInvalidState',
  'KmsNotFound',
  'KmsOptInRequired',
  'KMSAccessDeniedException',
  'KMSDisabledException',
  'KMSInvalidStateException',
  'KMSNotFoundException',
])

// the host each partition's queues answer on; an ARN naming any other partition is refused rather than
// guessed at
const PARTITION_HOSTS: Record<string, string> = {
  aws: 'amazonaws.com',
  'aws-us-gov': 'amazonaws.com',
  'aws-cn': 'amazonaws.com.cn',
}

// checked by both queueUrlFromArn and sendLambda: an ARN naming a service, region or partition other than
// the one this function is deployed for is a fault in the allowlist entry, not something a retry fixes
function checkArn(arn: string, service: string, region: string): { partition: string; accountId: string } {
  const [prefix, partition, arnService, arnRegion, accountId] = arn.split(':')
  if (prefix !== 'arn' || arnService !== service || !accountId) {
    throw new Error(`${arn} is not a recognisable ${service} ARN`)
  }
  if (!partition || !PARTITION_HOSTS[partition]) {
    throw new Error(`${arn} names a partition this sender does not recognise`)
  }
  if (arnRegion !== region) throw new Error(`${arn} is in another region than this function`)
  return { partition, accountId }
}

export function queueUrlFromArn(arn: string, region: string): string {
  const parts = arn.split(':')
  const { partition, accountId } = checkArn(arn, 'sqs', region)
  // a queue name never contains a colon, so anything past the account id must be exactly one segment - an
  // extra segment here would otherwise silently address a different queue
  const name = parts[5]
  if (parts.length !== 6 || !name) throw new Error(`${arn} is not a queue ARN`)
  return `https://sqs.${parts[3]}.${PARTITION_HOSTS[partition]}/${accountId}/${name}`
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

  let queueUrl: string
  try {
    queueUrl = queueUrlFromArn(queueArn, deps.region)
  } catch (err) {
    // a malformed or cross-region allowlist entry is a configuration fault, not a delivery AWS ever attempted
    return { kind: 'permanent', error: truncate((err as Error).message) }
  }

  try {
    await deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
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
  if (!deps.lambda || !deps.region) return { kind: 'permanent', error: 'no Lambda client is configured' }
  if (!allowed(deps, functionArn)) return refuse(functionArn)

  try {
    // the mirror of queueUrlFromArn's check: sendSqs builds a URL from the region and partition, sendLambda
    // invokes the ARN directly, but a wrong region or partition is the same configuration fault either way
    checkArn(functionArn, 'lambda', deps.region)
  } catch (err) {
    return { kind: 'permanent', error: truncate((err as Error).message) }
  }

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
