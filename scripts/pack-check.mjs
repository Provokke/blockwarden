import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

// Packs each published package the way `pnpm publish` would and checks the tarball itself: the manifest's
// exports point at files that are in it, every entry imports under plain Node, and it exports what consumers use.
const packages = {
  'packages/kms-signer': {
    '.': ['toKmsAccount', 'toDigestSignerAccount', 'kmsDigestSigner', 'InvalidSignatureError', 'InvalidPublicKeyError'],
    './testing': ['createLocalDigestSigner'],
  },
  'packages/relayer-client': {
    '.': [
      'relay',
      'getTx',
      'listSigners',
      'verifyWebhook',
      'signWebhook',
      'RelayerApiError',
      'TX_STATUSES',
      'isMatchEvent',
      'toDecodedValue',
      'WEBHOOK_SPEC_VERSION',
      'MATCH_STATUSES',
    ],
  },
}

// through a shell, because pnpm on Windows is a .cmd shim; the arguments are fixed strings from this file
const pnpm = (args, cwd) => {
  const result = spawnSync(`pnpm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// a tar archive is 512-byte headers, each followed by its file padded to 512 bytes
function extract(tgz, dest) {
  const tar = gunzipSync(readFileSync(tgz))
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    if (!name) break
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (header[156] === 0x30 || header[156] === 0) {
      const path = join(dest, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

let failures = 0
for (const [dir, entries] of Object.entries(packages)) {
  const root = resolve(dir)
  const out = join(root, '.pack')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'stale.js'), '')
  pnpm(['run', 'build'], root)
  pnpm(['pack', '--pack-destination', out], root)
  const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'))
  // extracted inside the package, so imports resolve through the package's own node_modules
  extract(join(out, tgz), out)
  const manifest = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8'))
  // a changelog a consumer can only read on GitHub is one they will not read, so one that exists must ship
  const required = ['README.md', 'LICENSE', ...(existsSync(join(root, 'CHANGELOG.md')) ? ['CHANGELOG.md'] : [])]
  for (const file of required) {
    try {
      readFileSync(join(out, 'package', file))
    } catch {
      console.error(`${manifest.name}: ${file} is not in the tarball`)
      failures++
    }
  }

  // older resolvers and some bundlers read only the top-level fields
  for (const field of ['main', 'types']) {
    if (typeof manifest[field] !== 'string') {
      console.error(`${manifest.name}: ${field} is not set in the packed manifest`)
      failures++
      continue
    }
    try {
      readFileSync(join(out, 'package', manifest[field]))
    } catch {
      console.error(`${manifest.name}: ${field} ${manifest[field]} is not in the tarball`)
      failures++
    }
  }
  if (manifest.sideEffects !== false) {
    console.error(`${manifest.name}: sideEffects is not false`)
    failures++
  }
  // build clears dist first, so a file from a deleted source cannot ride along
  if (readdirSync(join(out, 'package', 'dist')).includes('stale.js')) {
    console.error(`${manifest.name}: dist holds a file the build did not write`)
    failures++
  }

  for (const [entry, names] of Object.entries(entries)) {
    const target = manifest.exports?.[entry]
    const fail = (message) => {
      console.error(`${manifest.name} ${entry}: ${message}`)
      failures++
    }
    if (!target?.types || !target?.default) {
      fail('exports has no types and default condition')
      continue
    }
    for (const file of [target.types, target.default]) {
      try {
        readFileSync(join(out, 'package', file))
      } catch {
        fail(`${file} is not in the tarball`)
      }
    }
    const module = await import(pathToFileURL(join(out, 'package', target.default)).href)
    for (const name of names) if (!(name in module)) fail(`does not export ${name}`)
    console.log(`${manifest.name}${entry === '.' ? '' : entry.slice(1)}: ${names.length} exports load from the tarball`)
  }
}
if (failures > 0) process.exit(1)
