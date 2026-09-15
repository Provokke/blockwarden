export const keys = {
  cursor: (chainId: number) => ({ PK: `CHAIN#${chainId}`, SK: 'CURSOR' }),
  lease: (chainId: number) => ({ PK: `CHAIN#${chainId}`, SK: 'LEASE' }),
  rule: (ruleId: string) => ({ PK: `RULE#${ruleId}`, SK: 'META' }),
  match: (matchKey: string) => ({ PK: `MATCH#${matchKey}`, SK: 'META' }),
  activeRules: (chainId: number) => `CHAIN#${chainId}#RULES`,
  ruleOrder: (ruleId: string) => `RULE#${ruleId}`,
  matchesByRule: (ruleId: string) => `RULE#${ruleId}`,
  matchOrder: (blockNumber: number, logIndex: number) =>
    `${String(blockNumber).padStart(12, '0')}#${String(logIndex).padStart(6, '0')}`,
  provisionalMatches: (chainId: number) => `CHAIN#${chainId}#PROVISIONAL`,
}
