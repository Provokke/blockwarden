// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { HEADERS_TEMPLATE, buildPolicy, renderHeadersFunction } from '../scripts/csp-hashes.mjs'

interface ViewerResponse {
  statusCode: number
  statusDescription: string
  headers: Record<string, { value: string }>
}

type Handler = (event: { response: ViewerResponse }) => ViewerResponse

// the two hashes csp-hashes.test.ts computes with openssl, for window.__x = 1; and {"a":1}
const HASHES = [
  'sha256-lyTN6OpbNBmA84UPafLhT+mqPgMl6Zh8SXt5ZSZ/s1g=',
  'sha256-AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=',
]

// written out by hand rather than built by buildPolicy, so a change to either side shows here
const POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'sha256-lyTN6OpbNBmA84UPafLhT+mqPgMl6Zh8SXt5ZSZ/s1g=' 'sha256-AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI='; " +
  "style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
  "form-action 'self'; object-src 'none'"

// What Managed-SecurityHeadersPolicy adds before the function runs, as AWS documents it ("Use managed response
// headers policies"). CloudFront inserts a policy's headers before the viewer-response event, so the function
// receives them in event.response.headers.
const MANAGED_BASELINE = {
  'referrer-policy': { value: 'strict-origin-when-cross-origin' },
  'strict-transport-security': { value: 'max-age=31536000' },
  'x-content-type-options': { value: 'nosniff' },
  'x-frame-options': { value: 'SAMEORIGIN' },
  'x-xss-protection': { value: '1; mode=block' },
}

// The function ships as the rendered template, with no module wrapper and no exports, so it is evaluated here the
// way CloudFront runs it: as a script that declares handler. It is rendered as the dashboard's size check renders
// it, which a test in csp-hashes.test.ts ties to site.tf's templatefile() call.
async function loadHandler(hashes: string[]): Promise<Handler> {
  const code = renderHeadersFunction(await readFile(HEADERS_TEMPLATE, 'utf8'), buildPolicy(hashes))
  return new Function(`${code}\nreturn handler`)() as Handler
}

const response = (headers: ViewerResponse['headers'] = {}): ViewerResponse => ({
  statusCode: 200,
  statusDescription: 'OK',
  headers,
})

describe('the security headers function', () => {
  it("replaces the managed baseline with this stack's stricter values and the policy for these hashes", async () => {
    const handler = await loadHandler(HASHES)
    expect(handler({ response: response({ ...MANAGED_BASELINE }) }).headers).toEqual({
      'content-security-policy': { value: POLICY },
      'strict-transport-security': { value: 'max-age=31536000; includeSubDomains; preload' },
      'x-content-type-options': { value: 'nosniff' },
      'x-frame-options': { value: 'DENY' },
      'referrer-policy': { value: 'same-origin' },
    })
  })

  it('sets the same five on a response with no baseline, and keeps every other header', async () => {
    const handler = await loadHandler(HASHES)
    const result = handler({
      response: response({
        'content-type': { value: 'text/html' },
        'cache-control': { value: 'max-age=60' },
        'content-security-policy': { value: 'default-src *' },
      }),
    })
    expect(result.statusCode).toBe(200)
    expect(result.statusDescription).toBe('OK')
    expect(result.headers).toEqual({
      'content-type': { value: 'text/html' },
      'cache-control': { value: 'max-age=60' },
      'content-security-policy': { value: POLICY },
      'strict-transport-security': { value: 'max-age=31536000; includeSubDomains; preload' },
      'x-content-type-options': { value: 'nosniff' },
      'x-frame-options': { value: 'DENY' },
      'referrer-policy': { value: 'same-origin' },
    })
  })

  it("admits only 'self' when the export has no inline scripts", async () => {
    const handler = await loadHandler([])
    expect(handler({ response: response() }).headers['content-security-policy']?.value).toContain(
      "script-src 'self'; style-src",
    )
  })
})
