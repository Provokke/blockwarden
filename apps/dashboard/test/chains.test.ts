import { arbitrum, base, mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { parseChainIds } from '../src/lib/chains.js'

describe('parseChainIds', () => {
  it('defaults to the demo deployment when unset', () => {
    expect(parseChainIds(undefined).map((c) => c.id)).toEqual([1, 8453, 42161])
  })

  it('maps ids to their chain objects, in the order given', () => {
    expect(parseChainIds('8453, 1')).toEqual([base, mainnet])
    expect(parseChainIds('42161')).toEqual([arbitrum])
  })

  it.each(['', '  ', '1,,8453', '1,abc', '1.5', '-1', '0', '999999', '1,1', '0x1'])(
    'fails loudly on %j instead of dropping it',
    (raw) => {
      expect(() => parseChainIds(raw)).toThrow(/NEXT_PUBLIC_CHAIN_IDS/)
    },
  )
})
