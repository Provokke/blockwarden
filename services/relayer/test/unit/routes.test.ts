import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../../src/api.js'

// API Gateway only forwards the routes Terraform registers, and the handler only answers the keys it knows,
// so a route added on one side alone would be unreachable or answer 404
describe('route keys', () => {
  it('match between the handler and modules/relayer', () => {
    const tf = readFileSync(new URL('../../../../infra/terraform/modules/relayer/api.tf', import.meta.url), 'utf8')
    const block = /routes = \[([^\]]*)\]/.exec(tf)?.[1] ?? ''
    const registered = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(registered.length).toBeGreaterThan(0)
    expect(registered.sort()).toEqual(Object.values(ROUTES).sort())
  })
})
