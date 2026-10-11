import { DestinationError, postJson, resolveDestination, type Resolved } from '../destination.js'
import { truncate } from '../records.js'
import { summarise } from './render-text.js'
import type { Sender, SendOutcome } from './types.js'

const DEFAULT_API_BASE = 'https://api.telegram.org'

export const sendTelegram: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'telegram')
    throw new Error(`delivery ${delivery.deliveryId} is not a telegram message`)
  if (!deps.telegramTokenParameter) return { kind: 'permanent', error: 'no Telegram bot token is configured' }

  let first: string | undefined
  try {
    ;[first] = await deps.secrets.read(deps.telegramTokenParameter)
  } catch (err) {
    return { kind: 'retry', error: truncate(`the Telegram token could not be read: ${(err as Error).message}`) }
  }
  // an empty parameter is a rotation half done more often than a decision, and the URL would otherwise be
  // built with the word undefined where the token belongs
  if (!first) {
    return { kind: 'retry', error: truncate(`parameter ${deps.telegramTokenParameter} holds no Telegram bot token`) }
  }
  const token = first

  // summarise() already caps the text at 4096 characters, which is Telegram's own limit for one message
  const { text } = summarise(delivery.payload)
  const body = JSON.stringify({
    chat_id: delivery.target.chatId,
    text,
    disable_web_page_preview: true,
  })

  const resolve = deps.resolve ?? ((raw: string) => resolveDestination(raw, deps.resolver))
  const post = deps.post ?? postJson
  try {
    // the host is ours, not a caller's, but it goes through the same resolve-and-pin path as everything else
    const base = await resolve(`${deps.telegramApiBase ?? DEFAULT_API_BASE}/`)
    const target: Resolved = { ...base, url: new URL(`${base.url.origin}/bot${token}/sendMessage`) }
    const answer = await post(
      target,
      body,
      {},
      {
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }),
      },
    )
    // the token is in the path, so nothing about this request other than the parsed answer goes into an error
    return classify(answer.statusCode, answer.body)
  } catch (err) {
    if (err instanceof DestinationError) {
      // a base URL the guard refuses is refused again next time; a resolver that could not answer may not be
      return err.retryable
        ? { kind: 'retry', error: truncate(err.message) }
        : { kind: 'permanent', error: truncate(err.message) }
    }
    return { kind: 'retry', error: truncate(`Telegram could not be reached: ${(err as Error).message}`) }
  }
}

type Answer = { ok?: boolean; description?: string; parameters?: { retry_after?: number } }

function classify(statusCode: number, body: string): SendOutcome {
  let answer: Answer | undefined
  try {
    answer = JSON.parse(body) as Answer
  } catch {
    return {
      kind: 'retry',
      error: truncate(`Telegram answered ${statusCode} with something that is not JSON`),
      statusCode,
    }
  }
  if (statusCode >= 200 && statusCode < 300 && answer.ok === true) return { kind: 'delivered', statusCode }
  const description = truncate(`Telegram answered ${statusCode}: ${answer.description ?? 'no description'}`)
  const retryAfter = answer.parameters?.retry_after
  if (statusCode === 429) {
    return {
      kind: 'retry',
      error: description,
      statusCode,
      ...(typeof retryAfter === 'number' ? { afterSeconds: retryAfter } : {}),
    }
  }
  if (statusCode >= 500) return { kind: 'retry', error: description, statusCode }
  // 401 and 404 answer our own bot token, which is operator configuration the secret cache holds for five
  // minutes: a rotation would make every alert look like a dead token and dead-letter it. Retrying a token
  // that really is dead costs eight attempts and dead-letters anyway, which is the cheaper mistake. A 400 is
  // the chat id the tenant configured, and that does not improve on a retry.
  if (statusCode === 401 || statusCode === 404) return { kind: 'retry', error: description, statusCode }
  return { kind: 'permanent', error: description, statusCode }
}
