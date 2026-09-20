export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

export type BumpResult = { ok: true; fees: Fees } | { ok: false; required: Fees }

// geth's default txpool.pricebump, which op-geth on Base keeps
export const DEFAULT_PRICE_BUMP_PERCENT = 10n

const max = (a: bigint, b: bigint) => (a > b ? a : b)
const min = (a: bigint, b: bigint) => (a < b ? a : b)

// geth's list.Add: both fields must rise, and each must reach old * (100 + bump) / 100, rounded down
export function isAcceptedReplacement(
  previous: Fees,
  next: Fees,
  priceBumpPercent: bigint = DEFAULT_PRICE_BUMP_PERCENT,
): boolean {
  if (previous.maxFeePerGas >= next.maxFeePerGas || previous.maxPriorityFeePerGas >= next.maxPriorityFeePerGas) {
    return false
  }
  const threshold = (old: bigint) => (old * (100n + priceBumpPercent)) / 100n
  return (
    next.maxFeePerGas >= threshold(previous.maxFeePerGas) &&
    next.maxPriorityFeePerGas >= threshold(previous.maxPriorityFeePerGas)
  )
}

// the least fees a node with this price bump accepts in place of previous
export function minReplacementFees(previous: Fees, priceBumpPercent: bigint = DEFAULT_PRICE_BUMP_PERCENT): Fees {
  const least = (old: bigint) => max((old * (100n + priceBumpPercent)) / 100n, old + 1n)
  return { maxFeePerGas: least(previous.maxFeePerGas), maxPriorityFeePerGas: least(previous.maxPriorityFeePerGas) }
}

export function clampFees(estimate: Fees, cap: Fees): Fees {
  const maxFeePerGas = min(estimate.maxFeePerGas, cap.maxFeePerGas)
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: min(min(estimate.maxPriorityFeePerGas, cap.maxPriorityFeePerGas), maxFeePerGas),
  }
}

// Each field goes to the greater of 12.5% over previous and the current estimate, and never below the node's
// minimum, then the policy cap applies. A cap under that minimum makes a replacement impossible, so ok is false.
export function bumpFees(
  previous: Fees,
  estimate: Fees,
  cap: Fees,
  priceBumpPercent: bigint = DEFAULT_PRICE_BUMP_PERCENT,
): BumpResult {
  const required = minReplacementFees(previous, priceBumpPercent)
  const raise = (old: bigint, estimated: bigint, least: bigint) =>
    max(max((old * 1125n + 999n) / 1000n, estimated), least)
  const fees = clampFees(
    {
      maxFeePerGas: raise(previous.maxFeePerGas, estimate.maxFeePerGas, required.maxFeePerGas),
      maxPriorityFeePerGas: raise(
        previous.maxPriorityFeePerGas,
        estimate.maxPriorityFeePerGas,
        required.maxPriorityFeePerGas,
      ),
    },
    cap,
  )
  if (fees.maxFeePerGas < required.maxFeePerGas || fees.maxPriorityFeePerGas < required.maxPriorityFeePerGas) {
    return { ok: false, required }
  }
  return { ok: true, fees }
}
