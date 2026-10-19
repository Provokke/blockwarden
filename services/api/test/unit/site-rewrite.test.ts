import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface CloudFrontRequest {
  uri: string
  method: string
  headers: Record<string, { value: string }>
}

type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest

// The function ships as the file itself, through Terraform's file(), with no module wrapper and no exports, so
// it is evaluated here the way CloudFront runs it: as a script that declares handler.
async function loadHandler(): Promise<Handler> {
  const source = await readFile(
    new URL('../../../../infra/terraform/modules/api/site-rewrite.js', import.meta.url),
    'utf8',
  )
  return new Function(`${source}\nreturn handler`)() as Handler
}

async function rewrite(uri: string): Promise<CloudFrontRequest> {
  const handler = await loadHandler()
  return handler({ request: { uri, method: 'GET', headers: { host: { value: 'd111111abcdef8.cloudfront.net' } } } })
}

// the dashboard is exported with trailingSlash: true, so every page is <route>/index.html in the bucket
describe('the site rewrite function', () => {
  it.each([
    ['/', '/index.html'],
    ['/rules', '/rules/index.html'],
    ['/rules/', '/rules/index.html'],
    ['/rules/abc', '/rules/abc/index.html'],
    // only the last segment says whether a path is a file
    ['/releases/v1.2/notes', '/releases/v1.2/notes/index.html'],
  ])('serves %s from %s', async (uri, object) => {
    expect((await rewrite(uri)).uri).toBe(object)
  })

  it.each(['/_next/static/x.js', '/favicon.ico', '/index.html', '/rules/index.html'])(
    'passes the file %s through unchanged',
    async (uri) => {
      expect((await rewrite(uri)).uri).toBe(uri)
    },
  )

  it('hands back the same request, with everything but the URI untouched', async () => {
    const request = await rewrite('/rules')
    expect(request.method).toBe('GET')
    expect(request.headers).toEqual({ host: { value: 'd111111abcdef8.cloudfront.net' } })
  })
})
