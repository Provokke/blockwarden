import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FOUNDRY_VERSION = '1.8.1'
const image = `ghcr.io/foundry-rs/foundry:v${FOUNDRY_VERSION}`
const contracts = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(contracts, '..')
// the profile that picks the fuzz and invariant run counts
const forwardedEnv = ['FOUNDRY_PROFILE']

// pnpm links node_modules with junctions on Windows, and Docker Desktop shows a junction inside a container as a
// link to /mnt/host/<drive>/<path>, so the repository is mounted at that path for the remappings to resolve.
// Elsewhere pnpm's links are relative and the host path serves as the mount point.
export function containerPath(hostPath, platform = process.platform) {
  if (platform !== 'win32') return hostPath
  const [drive = '', ...rest] = hostPath.split(/[\\/]+/).filter(Boolean)
  return `/mnt/host/${drive.replace(':', '').toLowerCase()}/${rest.join('/')}`
}

function localForgeMatches() {
  const probe = spawnSync('forge', ['--version'], { encoding: 'utf8' })
  // another Foundry may default to another EVM version, and different bytecode moves every CREATE2 address
  return probe.status === 0 && probe.stdout.split(/\r?\n/).includes(`forge Version: ${FOUNDRY_VERSION}`)
}

export function forge(args) {
  if (localForgeMatches()) {
    return spawnSync('forge', args, { cwd: contracts, stdio: 'inherit' }).status ?? 1
  }
  const workdir = containerPath(contracts)
  const dockerArgs = ['run', '--rm', '-v', `${repo}:${containerPath(repo)}`, '-w', workdir]
  // forge writes out/ and cache/ into the mount, which would otherwise belong to the image's user
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    dockerArgs.push('--user', `${process.getuid()}:${process.getgid()}`)
  }
  // forge downloads solc into HOME; a HOME inside the mount keeps it between runs
  dockerArgs.push('-e', `HOME=${workdir}/.forge-home`)
  // forge asks git about the project, and git refuses a repository owned by another user unless told it is safe
  dockerArgs.push('-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*')
  for (const name of forwardedEnv) if (process.env[name] !== undefined) dockerArgs.push('-e', name)
  dockerArgs.push('--entrypoint', 'forge', image, ...args)
  const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' })
  if (result.error) console.error(`neither forge ${FOUNDRY_VERSION} nor docker could be run: ${result.error.message}`)
  return result.status ?? 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(forge(process.argv.slice(2)))
}
