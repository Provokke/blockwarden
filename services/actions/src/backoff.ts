// SQS takes at most 900 seconds of delay, so every wait fits in one message and the reaper stays a backstop
export const MAX_DELAY_SECONDS = 900
const BASE_SECONDS = 10
const FACTOR = 3
const JITTER = 0.2

export function nextDelaySeconds(
  attempts: number,
  afterSeconds: number | undefined,
  random: () => number = Math.random,
): number {
  const base = Math.min(BASE_SECONDS * FACTOR ** Math.max(0, attempts - 1), MAX_DELAY_SECONDS)
  const jittered = base * (1 - JITTER + 2 * JITTER * random())
  // a destination asking for longer is honoured; one asking for less than the backoff is not, or the last
  // attempts would turn into a hot loop against a server that is already struggling
  const asked = typeof afterSeconds === 'number' && Number.isFinite(afterSeconds) && afterSeconds > 0 ? afterSeconds : 0
  return Math.max(1, Math.min(MAX_DELAY_SECONDS, Math.round(Math.max(jittered, asked))))
}
