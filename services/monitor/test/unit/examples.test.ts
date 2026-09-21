import { readdirSync, readFileSync } from 'node:fs'
import { compileRule, ruleInputSchema } from '@blockwarden/core'
import { describe, expect, it } from 'vitest'

const dir = new URL('../../../../examples/', import.meta.url)

describe('examples', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it('has at least one example rule', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // an example is a write path too: it must compile with nothing dropped, which is what rule:put enforces
  it.each(files)('%s is a valid rule', (file) => {
    const input = ruleInputSchema.parse(JSON.parse(readFileSync(new URL(file, dir), 'utf8')))
    expect(compileRule(file, input).warnings).toEqual([])
  })
})
