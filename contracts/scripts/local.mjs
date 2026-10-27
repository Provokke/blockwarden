import { pathToFileURL } from 'node:url'
import { forge } from './forge.mjs'

// Anvil's first default account. Anvil keeps its default accounts unlocked, so the script sends through the node
// and no key is ever passed on a command line.
export const ANVIL_SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const scripts = { deploy: 'script/Deploy.s.sol:Deploy', fund: 'script/Fund.s.sol:Fund' }

export function runLocal(name, rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545') {
  const target = scripts[name]
  if (target === undefined)
    throw new Error(`unknown script ${name}; expected one of ${Object.keys(scripts).join(', ')}`)
  return forge(['script', target, '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', ANVIL_SENDER], {
    rpcUrl,
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runLocal(process.argv[2] ?? ''))
}
