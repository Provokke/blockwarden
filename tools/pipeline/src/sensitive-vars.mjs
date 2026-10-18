// Fails when a Terraform variable whose name says it holds a secret is not marked sensitive, because this
// repository's Actions logs are public and Terraform prints every value it is not told to hide.
// Usage: node tools/pipeline/src/sensitive-vars.mjs [directory]   (default infra/terraform)
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { variables } from './hcl.mjs'

export const SECRET_NAME = /secret|key|token|password|rpc_url/i

// These hold the name of an SSM parameter, or a prefix of one, and never its value: the modules check each against
// the parameter-name pattern, and the functions read the value at run time. Marking them sensitive would hide the
// IAM policies built from them in every plan, and Terraform refuses a sensitive value in for_each.
export const REFERENCE_SUFFIX = /_(parameter|parameters|prefixes)$/

// Reviewed names that match SECRET_NAME and hold no secret, keyed by the variable's path from the scanned
// directory, then a colon and the variable name.
export const REVIEWED = new Map([
  [
    'modules/relayer/variables.tf:api_keys',
    'labels and signer ids for keys the module generates itself; a key value is never passed in',
  ],
])

const posix = (path) => path.split(sep).join('/')

async function terraformFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.terraform') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await terraformFiles(path)))
    else if (entry.name.endsWith('.tf')) found.push(path)
  }
  return found.sort()
}

// Each variable that needs sensitive = true and lacks it, as { file, line, variable, name }, where name is the
// variable's own name or the attribute in its type that matched. Values are never read.
export async function check(dir, reviewed = REVIEWED) {
  const problems = []
  const used = new Set()
  const files = new Set()
  let checked = 0
  for (const file of await terraformFiles(dir)) {
    const path = posix(relative(dir, file))
    files.add(path)
    for (const v of variables(await readFile(file, 'utf8'))) {
      checked++
      if (v.sensitive) continue
      for (const name of [v.name, ...v.attributes]) {
        if (!SECRET_NAME.test(name) || REFERENCE_SUFFIX.test(name)) continue
        const key = `${path}:${v.name}`
        if (reviewed.has(key)) {
          used.add(key)
          continue
        }
        problems.push({ file: path, line: v.line, variable: v.name, name })
      }
    }
  }
  // a reviewed entry whose variable has gone would otherwise excuse whatever later takes its name
  const stale = [...reviewed.keys()].filter((key) => !used.has(key) && files.has(key.slice(0, key.lastIndexOf(':'))))
  return { checked, problems, stale }
}

export function report({ checked, problems, stale }) {
  const lines = problems.map(
    (p) =>
      `${p.file}:${p.line} variable "${p.variable}"${p.name === p.variable ? '' : ` (its ${p.name} attribute)`} looks secret and is not sensitive = true`,
  )
  for (const key of stale) lines.push(`${key} is reviewed in sensitive-vars.mjs but no longer matches; remove it`)
  if (lines.length === 0) lines.push(`${checked} variables checked; every secret-looking one is sensitive or reviewed`)
  return lines.join('\n')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../infra/terraform', import.meta.url)))
  const result = await check(dir)
  const failed = result.problems.length > 0 || result.stale.length > 0
  ;(failed ? console.error : console.log)(report(result))
  process.exitCode = failed ? 1 : 0
}
