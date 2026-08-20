export { compileRule, RuleValidationError, type CompiledRule, type ValidationIssue } from './compile.js'
export { evaluate, resolveField } from './conditions.js'
export { buildLogFilter, type LogFilter } from './filter.js'
export { matchKey } from './ids.js'
export { assignOrdinals, dedupeLogs, matchLog, type KeyedMatch, type LogMatch } from './match.js'
export {
  conditionOps,
  conditionSchema,
  confirmationSchema,
  ruleInputSchema,
  type Condition,
  type ConditionOp,
  type Confirmation,
  type Leaf,
  type RuleInput,
  type Scalar,
} from './rule.js'
export type { RawLog } from './types.js'
export { DeadlineError, fetchLogsAdaptive, type FetchLogsOptions, type FetchRange } from './fetch-logs.js'
