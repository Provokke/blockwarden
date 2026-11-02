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
  // an empty parameter is more often a half-done rotation, and the URL would get the word undefined
  // where the token goes
  if (!first) {
    return { kind: 'retry', error: truncate(`parameter ${deps.telegramTokenParameter} holds no Telegram bot token`) }
  }
  const token = first

  // summarise() already caps the text at Telegram's 4096-char limit
  const { text } = summarise(delivery.payload)
  const body = JSON.stringify({
    chat_id: delivery.target.chatId,
    text,
    disable_web_page_preview: true,
  })

  const resolve = deps.resolve ?? ((raw: string) => resolveDestination(raw, deps.resolver))
  const post = deps.post ?? postJson
  try {
    // the host is ours, but it still goes through the same resolve-and-pin path
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
    // the token is in the path, so only the parsed answer goes into an error
    return classify(answer.statusCode, answer.body)
  } catch (err) {
    if (err instanceof DestinationError) {
      // a base URL the guard refuses is refused again; a resolver that couldn't answer may work
      // next time
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
  // 401 and 404 are our own bot token, which the secret cache holds for five minutes: a rotation
  // would make every alert look like a dead token. Retrying a really dead token costs eight
  // attempts, the cheaper mistake. A 400 is the tenant's chat id, which a retry won't fix.
  if (statusCode === 401 || statusCode === 404) return { kind: 'retry', error: description, statusCode }
  return { kind: 'permanent', error: description, statusCode }
}
