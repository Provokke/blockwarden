import type { RawLog } from './types.js'

export type FetchRange = (from: number, to: number) => Promise<RawLog[]>

export type FetchLogsOptions = {
  // checked before every fetch, including each sub-range of a halved range
  shouldStop?: () => boolean
  // called in block order for every range that was read in full, before the next fetch
  onChunk?: (from: number, to: number, logs: RawLog[]) => void | Promise<void>
}

export class DeadlineError extends Error {
  constructor(message = 'the deadline passed before the log request was sent') {
    super(message)
    this.name = 'DeadlineError'
  }
}

export async function fetchLogsAdaptive(
  from: number,
  to: number,
  fetchRange: FetchRange,
  isHalvable: (err: unknown) => boolean,
  options: FetchLogsOptions = {},
): Promise<RawLog[]> {
  const collected: RawLog[] = []
  const walk = async (f: number, t: number): Promise<void> => {
    if (options.shouldStop?.()) throw new DeadlineError()
    let logs: RawLog[] | undefined
    try {
      logs = await fetchRange(f, t)
    } catch (err) {
      if (f === t || !isHalvable(err)) throw err
    }
    if (logs === undefined) {
      const mid = Math.floor((f + t) / 2)
      await walk(f, mid)
      await walk(mid + 1, t)
      return
    }
    // outside the try, so a failed write is never mistaken for a refused range
    await options.onChunk?.(f, t, logs)
    collected.push(...logs)
  }
  await walk(from, to)
  return collected
}
