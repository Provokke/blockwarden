import { postJson, resolveDestination, type Resolved } from '../destination.js'
import { truncate } from '../records.js'
import { summarise } from './render-text.js'
import type { Sender, SendOutcome } from './types.js'

const DEFAULT_API_BASE = 'https://api.telegram.org'
// Telegram refuses a message above this; the rendering is already capped below it
const MAX_MESSAGE = 4_096

export const sendTelegram: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'telegram')
    throw new Error(`delivery ${delivery.deliveryId} is not a telegram message`)
  if (!deps.telegramTokenParameter) return { kind: 'permanent', error: 'no Telegram bot token is configured' }

  let token: string
  try {
    const [first] = await deps.secrets.read(deps.telegramTokenParameter)
    token = first!
  } catch (err) {
    return { kind: 'retry', error: truncate(`the Telegram token could not be read: ${(err as Error).message}`) }
  }

  const { text } = summarise(delivery.payload)
  const body = JSON.stringify({
    chat_id: delivery.target.chatId,
    text: text.slice(0, MAX_MESSAGE),
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
  // 401 is a bad token, 404 a malformed one, 400 a chat the bot cannot post to: none of them changes on a retry
  return { kind: 'permanent', error: description, statusCode }
}
