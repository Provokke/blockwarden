export const keys = {
  signer: (signerId: string) => ({ PK: `SIGNER#${signerId}`, SK: 'META' }),
  nonce: (signerId: string, chainId: number) => ({ PK: `SIGNER#${signerId}`, SK: `NONCE#${chainId}` }),
  pause: (signerId: string, chainId: number) => ({ PK: `SIGNER#${signerId}`, SK: `PAUSE#${chainId}` }),
  spend: (signerId: string, chainId: number, day: string) => ({
    PK: `SIGNER#${signerId}`,
    SK: `SPEND#${chainId}#${day}`,
  }),
  tx: (txId: string) => ({ PK: `TX#${txId}`, SK: 'META' }),
  // the API key hash is fixed-length hex, so a # inside the caller's key cannot make two keys collide
  idempotency: (apiKeyHash: string, key: string) => ({ PK: `IDEMP#${apiKeyHash}#${key}`, SK: 'META' }),
  apiKey: (hash: string) => ({ PK: `APIKEY#${hash}`, SK: 'META' }),
  pendingTxs: (chainId: number) => `TXPENDING#${chainId}`,
}
