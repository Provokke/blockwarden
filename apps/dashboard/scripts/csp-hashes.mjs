// Hashes the export's inline scripts for the Content-Security-Policy the CloudFront security-headers function sets,
// and refuses a page the policy cannot admit. Usage: node scripts/csp-hashes.mjs [--dir out] [--out file | --check]
//
// Next writes its bootstrap and flight data inline, and the flight data changes with every build, so the hashes
// come from the build being uploaded and travel to Terraform as site.auto.tfvars.json.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// CloudFront's quota on a function's size (Quotas, "Maximum function size", 10 KB, not adjustable). The policy is
// written into the function's code, so the code's size is what bounds the hashes. AWS does not define its KB, so
// this takes the smaller reading.
export const FUNCTION_SIZE_LIMIT = 10000

// modules/api/site.tf renders the same file with templatefile(), passing the policy through jsonencode()
export const HEADERS_TEMPLATE = fileURLToPath(
  new URL('../../../infra/terraform/modules/api/security-headers.js.tftpl', import.meta.url),
)

// modules/api/site.tf builds the same list, and a test fails when the two differ. script-src is where the
// hashes go.
export const BASE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]

// Next's default not-found pages carry inline styles. CloudFront's rewrite function never serves them: a path
// with no exported page is an error from S3.
const STYLE_EXEMPT = [/^404\.html$/, /^404\/index\.html$/, /^_not-found\//]

export function buildPolicy(hashes) {
  return BASE_DIRECTIVES.map((directive) =>
    directive.startsWith('script-src ') ? [directive, ...hashes.map((h) => `'${h}'`)].join(' ') : directive,
  ).join('; ')
}

// templatefile() with jsonencode(): a JSON string, and the five characters that Terraform's jsonencode escapes and
// JSON.stringify does not are escaped the same way
export function renderHeadersFunction(template, policy) {
  const parts = template.split('${csp}')
  if (parts.length !== 2) throw new Error('the security-headers template must hold ${csp} exactly once')
  const literal = JSON.stringify(policy).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return parts.join(literal)
}

// returns the code's size in bytes, which is what CloudFront counts
export function assertFits(code, hashCount) {
  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > FUNCTION_SIZE_LIMIT) {
    throw new Error(
      `the security-headers function would be ${bytes} bytes, over CloudFront's limit of ${FUNCTION_SIZE_LIMIT}, with ${hashCount} script hashes`,
    )
  }
  return bytes
}

async function htmlFiles(root) {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await htmlFiles(path)))
    else if (entry.name.endsWith('.html')) found.push(path)
  }
  return found
}

// quote-aware like START_TAG: a > inside a quoted attribute value does not end the tag
const SCRIPT_ELEMENT = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi
const START_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

function inspect(html) {
  const inline = []
  // a script's text is code or data, and can hold anything, so the markup checks look at the page without it
  const markup = html.replace(SCRIPT_ELEMENT, (_all, attributes, content) => {
    if (!/(^|\s)src\s*=/i.test(attributes)) inline.push(content)
    return '<script></script>'
  })

  const found = new Set()
  for (const [, tag, attributes] of markup.matchAll(START_TAG)) {
    if (tag.toLowerCase() === 'style') found.add('a <style> element')
    if (/(^|\s)style\s*=/i.test(attributes)) found.add('a style attribute')
    if (/(^|\s)on[a-z]+\s*=/i.test(attributes)) found.add('an inline event handler')
    if (/=\s*["']?\s*javascript:/i.test(attributes)) found.add('a javascript: URL')
  }
  return { inline, found }
}

export async function collect(root) {
  const hashes = new Set()
  const problems = []
  const exemptions = []

  for (const file of (await htmlFiles(root)).sort()) {
    const name = relative(root, file).split(sep).join('/')
    const { inline, found } = inspect(await readFile(file, 'utf8'))
    // The HTML parser turns CRLF and a lone CR into LF before a script's text exists, so a CR here would hash to
    // something the browser never computes.
    if (inline.some((content) => content.includes('\r'))) {
      problems.push(`${name} has an inline script containing a carriage return, which a browser hashes as a line feed`)
    }
    for (const content of inline) hashes.add(`sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`)

    const exempt = STYLE_EXEMPT.some((pattern) => pattern.test(name))
    const refused = [...found].filter(
      (what) => !(exempt && (what === 'a style attribute' || what === 'a <style> element')),
    )
    if (exempt && refused.length < found.size) exemptions.push(`${name}: inline styles allowed, as a not-found page`)
    if (refused.length > 0) problems.push(`${name} has ${refused.join(' and ')}, which the policy would block`)
  }

  return { hashes: [...hashes].sort(), problems, exemptions }
}

function parseArgs(argv) {
  const options = { dir: 'out', out: undefined, check: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--check') {
      options.check = true
    } else if ((flag === '--dir' || flag === '--out') && argv[i + 1] !== undefined) {
      options[flag.slice(2)] = argv[++i]
    } else {
      throw new Error(`unexpected argument ${flag}`)
    }
  }
  if (options.check && options.out !== undefined) {
    throw new Error('--check writes nothing, so it cannot be combined with --out')
  }
  return options
}

async function main() {
  const { dir, out, check } = parseArgs(process.argv.slice(2))

  let result
  try {
    result = await collect(dir)
  } catch (error) {
    throw new Error(`cannot read the export in ${dir}: ${error.message}`)
  }

  for (const line of result.exemptions) console.error(`exempt: ${line}`)
  if (result.problems.length > 0) throw new Error(result.problems.join('\n'))
  if (result.hashes.length === 0) throw new Error(`${dir} has no inline scripts; is it the dashboard's export?`)

  const code = renderHeadersFunction(await readFile(HEADERS_TEMPLATE, 'utf8'), buildPolicy(result.hashes))
  const bytes = assertFits(code, result.hashes.length)

  const json = `${JSON.stringify({ site_script_hashes: result.hashes }, null, 2)}\n`
  if (check) {
    // the checks above are the whole job
  } else if (out === undefined) {
    process.stdout.write(json)
  } else {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, json)
  }
  console.error(
    `${result.hashes.length} script hashes, security-headers function ${bytes} of ${FUNCTION_SIZE_LIMIT} bytes`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
