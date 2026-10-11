// the cap is SQS's largest DelaySeconds and lives with the queue that enforces it, so the two cannot drift apart
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
  // the band hangs from the cap rather than straddling it: jittering around 900 and then clamping would put
  // every draw in the top half of the band on exactly 900, and a herd that failed together would come back
  // together on the attempts that matter most
  const high = Math.min(base * (1 + JITTER), MAX_DELAY_SECONDS)
  const low = high - 2 * JITTER * base
  const jittered = low + (high - low) * random()
  // a destination asking for longer is honoured; one asking for less than the backoff is not, or the last
  // attempts would turn into a hot loop against a server that is already struggling
  const asked = typeof afterSeconds === 'number' && Number.isFinite(afterSeconds) && afterSeconds > 0 ? afterSeconds : 0
  return Math.max(1, Math.min(MAX_DELAY_SECONDS, Math.round(Math.max(jittered, asked))))
}
