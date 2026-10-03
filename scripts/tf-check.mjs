import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// only infra/terraform is mounted, not the Lambda bundle the module zips, so plan and apply are not supported here
const tf = resolve('infra/terraform')
const terraform = 'hashicorp/terraform:1.16.2'
const tflint = 'ghcr.io/terraform-linters/tflint:v0.64.0'
const checkov = 'bridgecrew/checkov:3.3.17'

// terraform writes .terraform/ into the mounted tree, which would otherwise be owned by root on Linux
const asCaller =
  process.platform !== 'win32' && typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []

function run(label, args) {
  console.log(`\n> ${label}`)
  const result = spawnSync('docker', ['run', '--rm', '-v', `${tf}:/tf`, ...args], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('terraform fmt', [...asCaller, '-w', '/tf', terraform, 'fmt', '-check', '-recursive'])
// the demo stack uses every module; each example deploys one slice alone, with its defaults
for (const root of ['envs/demo', 'examples/relayer-only', 'examples/monitor-actions-only']) {
  run(`terraform init ${root}`, [...asCaller, '-w', `/tf/${root}`, terraform, 'init', '-backend=false', '-input=false'])
  run(`terraform validate ${root}`, [...asCaller, '-w', `/tf/${root}`, terraform, 'validate'])
}
run('tflint', [
  '-w',
  '/tf',
  '-e',
  'GITHUB_TOKEN',
  '--entrypoint',
  'sh',
  tflint,
  '-c',
  'tflint --init --config /tf/.tflint.hcl && tflint --recursive --config /tf/.tflint.hcl',
])
run('checkov', ['-w', '/tf', checkov, '-d', '/tf', '--framework', 'terraform', '--quiet', '--compact'])
