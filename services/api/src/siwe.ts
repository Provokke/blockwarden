import type { Address, PublicClient } from 'viem'
import { getAddress } from 'viem'
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import { NONCE_SECONDS, type NonceStore } from './store.js'

export { NONCE_SECONDS } from './store.js'

export async function issueNonce(store: NonceStore, nowMs: number): Promise<string> {
  const nonce = generateSiweNonce()
  await store.put(nonce, nowMs)
  return nonce
}

export type SiweSettings = {
  domain: string
  origin: string
  chainIds: number[]
  allowedWallets: Address[]
}

export type SiweDeps = {
  store: NonceStore
  settings: SiweSettings
  publicClient(chainId: number): PublicClient | undefined
  secret: Uint8Array
  now(): number
}

type Refusal = { ok: false; code: string; message: string }
type Accepted = { ok: true; address: Address; chainId: number; nonce: string }

// SiweMessage claims every field is present, but parseSiweMessage's own return type says otherwise: every
// field is optional, because it comes from a regex match against attacker-controlled text. A parameter typed
// SiweMessage let the malformed-message case go unchecked at the type level as well as at runtime; this is
// typed as what parseSiweMessage actually returns, and the function is total over it.
export function checkSiweMessage(
  message: ReturnType<typeof parseSiweMessage>,
  settings: SiweSettings,
  nowMs: number,
): Accepted | Refusal {
  if (!message.address || !message.nonce || !message.domain || !message.uri || message.chainId === undefined) {
    return no('siwe_malformed', 'the message is not a SIWE message')
  }
  if (message.domain !== settings.domain) return no('siwe_domain', 'the message is for another domain')
  // viem checks domain but not uri, and the two can disagree: a message signed for our domain with someone
  // else's uri is a message the user believed they were signing for that other site
  if (!isOurUri(message.uri, settings.origin)) return no('siwe_uri', 'the message is for another address')
  if (!settings.chainIds.includes(message.chainId)) return no('siwe_chain', 'the message names another chain')
  if (!message.expirationTime) return no('siwe_expired', 'the message must carry an expiry')
  if (message.expirationTime.getTime() > nowMs + NONCE_SECONDS * 1000) {
    return no('siwe_expiry_too_far', `the expiry must be within ${NONCE_SECONDS} seconds`)
  }
  if (message.notBefore && message.notBefore.getTime() > nowMs) {
    return no('siwe_not_yet_valid', 'the message is not valid yet')
  }
  if (!validateSiweMessage({ message, domain: settings.domain, time: new Date(nowMs) })) {
    return no('siwe_expired', 'the message is expired or malformed')
  }
  const allowed = settings.allowedWallets.map((wallet) => getAddress(wallet))
  const address = getAddress(message.address)
  if (!allowed.includes(address)) {
    return no('siwe_wallet', 'that wallet may not sign in to this deployment')
  }
  return { ok: true, address, chainId: message.chainId, nonce: message.nonce }
}

function isOurUri(uri: string, origin: string): boolean {
  // string prefixes let demo.blockwarden.dev.evil.example through; the URL's own origin does not
  try {
    return new URL(uri).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function no(code: string, message: string): Refusal {
  return { ok: false, code, message }
}
