import type { DeliveryStatus } from './records.js'

// four digits order the history entries of a transaction as numbers; the relayer caps its history well below 9999
const SEQ_WIDTH = 4

export const keys = {
  matchSubject: (matchKey: string) => `MATCH#${matchKey}`,
  txSubject: (txId: string) => `TX#${txId}`,
  outboundSubject: (requestId: string) => `OUTBOUND#${requestId}`,
  delivery: (subject: string, actionId: string, event: string, seq: number) => ({
    PK: subject,
    SK: `DELIVERY#${actionId}#${event}#${String(seq).padStart(SEQ_WIDTH, '0')}`,
  }),
  dueDeliveries: () => 'DELIVERY#DUE',
  deliveriesByStatus: (status: DeliveryStatus) => `DELIVERY#${status.toUpperCase()}`,
}
