// SQS's max DelaySeconds lives with the queue, so the two can't drift apart
import { MAX_DELAY_SECONDS } from './queue.js'

const BASE_SECONDS = 10
const FACTOR = 3
const JITTER = 0.2

export function nextDelaySeconds(
  attempts: number,
  afterSeconds: number | undefined,
  random: () => number = Math.random,
): number {
  const base = Math.min(BASE_SECONDS * FACTOR ** Math.max(0, attempts - 1), MAX_DELAY_SECONDS)
  // Jitter hangs from the cap, not around it. Clamping after jitter would pile half the draws onto
  // 900 and retries would herd together.
  const high = Math.min(base * (1 + JITTER), MAX_DELAY_SECONDS)
  const low = high - 2 * JITTER * base
  const jittered = low + (high - low) * random()
  // Honour a longer ask from the destination, but never go below our backoff or we'd hot-loop a
  // struggling server.
  const asked = typeof afterSeconds === 'number' && Number.isFinite(afterSeconds) && afterSeconds > 0 ? afterSeconds : 0
  return Math.max(1, Math.min(MAX_DELAY_SECONDS, Math.round(Math.max(jittered, asked))))
}
