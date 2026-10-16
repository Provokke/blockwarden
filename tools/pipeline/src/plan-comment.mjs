// Posts or updates the plan summary comment for one environment.
// Usage: terraform show -json tfplan | node tools/pipeline/src/plan-comment.mjs --environment staging --plan -
//        node tools/pipeline/src/plan-comment.mjs --environment staging --failed
// Reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, PR_NUMBER, RUN_URL and HEAD_SHA from the environment.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marker, render, summarize } from './plan-summary.mjs'
import { upsertComment } from './pr-comment.mjs'

export function parseArgs(argv) {
  const options = { failed: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--failed') options.failed = true
    else if ((flag === '--environment' || flag === '--plan') && argv[i + 1] !== undefined)
      options[flag.slice(2)] = argv[++i]
    else throw new Error(`unknown argument ${flag}`)
  }
  if (options.environment === undefined || !/^[a-z]+$/.test(options.environment)) {
    throw new Error('--environment takes a lowercase environment name')
  }
  if (options.failed === (options.plan !== undefined)) throw new Error('give --plan, or --failed, but not both')
  return options
}

async function readPlan(path) {
  let text
  if (path === '-') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    text = Buffer.concat(chunks).toString('utf8')
  } else {
    text = await readFile(path, 'utf8')
  }
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse quotes the text around the fault, and this text holds every value in the plan
    throw new Error('the plan is not valid JSON')
  }
}

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

export async function main(argv) {
  const options = parseArgs(argv)
  const summary = options.failed
    ? { add: 0, change: 0, destroy: 0, forget: 0, changes: [] }
    : summarize(await readPlan(options.plan))
  const body = render({
    environment: options.environment,
    summary,
    failed: options.failed,
    runUrl: required('RUN_URL'),
    sha: process.env.HEAD_SHA,
  })
  const result = await upsertComment({
    api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    token: required('GITHUB_TOKEN'),
    repository: required('GITHUB_REPOSITORY'),
    issue: required('PR_NUMBER'),
    marker: marker(options.environment),
    body,
  })
  console.log(`${result.action} comment ${result.id}: ${summary.changes.length} resource changes`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
