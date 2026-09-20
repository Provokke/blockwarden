import { z } from 'zod'
import { actionSchema } from './actions.js'

export const conditionOps = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const
export type ConditionOp = (typeof conditionOps)[number]

export type Scalar = string | number | boolean
export type Leaf = { field: string; op: ConditionOp; value: Scalar | Scalar[] }
export type Condition = Leaf | { all: Condition[] } | { any: Condition[] }

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
const scalar = z.union([z.string(), z.number(), z.boolean()])
const leaf = z.object({
  field: z.string().min(1),
  op: z.enum(conditionOps),
  value: z.union([scalar, z.array(scalar)]),
})

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leaf,
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
  ]),
)

export const confirmationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fast') }),
  z.object({ mode: z.literal('finalized') }),
])

export const ruleInputSchema = z.object({
  chainId: z.number().int().positive(),
  addresses: z.array(address).min(1).max(50),
  event: z.string().min(1),
  conditions: conditionSchema.optional(),
  confirmation: confirmationSchema,
  actions: z.array(actionSchema).max(5).default([]),
})

export type RuleInput = z.infer<typeof ruleInputSchema>
export type Confirmation = z.infer<typeof confirmationSchema>
