'use client'

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, apiFetch, type ApiIssue } from '../lib/api'
import { chains, chainName } from '../lib/chains'

export type RuleBody = {
  ruleId: string
  active: boolean
  chainId: number
  addresses: string[]
  event: string
  conditions?: unknown
  confirmation: { mode: 'fast' | 'finalized' }
  actions: Record<string, unknown>[]
}

type ActionType = 'webhook' | 'email' | 'telegram' | 'relay' | 'sqs' | 'lambda'
type FieldSpec = { name: string; label: string; optional?: boolean; list?: boolean; number?: boolean }

const ACTIONS: Record<ActionType, FieldSpec[]> = {
  webhook: [
    { name: 'url', label: 'URL' },
    { name: 'secretParameter', label: 'Secret parameter', optional: true },
    { name: 'signatureHeader', label: 'Signature header', optional: true },
    { name: 'deliveryHeader', label: 'Delivery header', optional: true },
  ],
  email: [
    { name: 'to', label: 'Recipients (comma separated)', list: true },
    { name: 'subject', label: 'Subject', optional: true },
  ],
  telegram: [{ name: 'chatId', label: 'Chat ID' }],
  relay: [
    { name: 'signerId', label: 'Signer ID' },
    { name: 'chainId', label: 'Chain ID', number: true },
    { name: 'to', label: 'To address' },
    { name: 'data', label: 'Calldata (0x...)' },
    { name: 'value', label: 'Value (wei)', optional: true },
    { name: 'gasLimit', label: 'Gas limit', optional: true },
  ],
  sqs: [{ name: 'queueArn', label: 'Queue ARN' }],
  lambda: [{ name: 'functionArn', label: 'Function ARN' }],
}
const ACTION_TYPES = Object.keys(ACTIONS) as ActionType[]

// The API refuses a longer list; stopping the button here saves a round trip for a rule it cannot accept.
const MAX_ACTIONS = 5

type ActionDraft = { type: ActionType; fields: Record<string, string> }
type Draft = {
  chainId: string
  addresses: string
  event: string
  confirmation: 'fast' | 'finalized'
  conditions: string
  actions: ActionDraft[]
  active: boolean
}

function emptyAction(type: ActionType): ActionDraft {
  return { type, fields: Object.fromEntries(ACTIONS[type].map((spec) => [spec.name, ''])) }
}

function draftFromRule(rule: RuleBody | undefined): Draft {
  if (!rule) {
    return {
      chainId: String(chains[0].id),
      addresses: '',
      event: '',
      confirmation: 'finalized',
      conditions: '',
      actions: [],
      active: true,
    }
  }
  return {
    chainId: String(rule.chainId),
    addresses: rule.addresses.join('\n'),
    event: rule.event,
    confirmation: rule.confirmation.mode,
    conditions: rule.conditions === undefined ? '' : JSON.stringify(rule.conditions, null, 2),
    active: rule.active,
    actions: rule.actions.map((action) => {
      const type = ACTION_TYPES.includes(action.type as ActionType) ? (action.type as ActionType) : 'webhook'
      const draft = emptyAction(type)
      for (const spec of ACTIONS[type]) {
        const value = action[spec.name]
        if (value === undefined) continue
        draft.fields[spec.name] = Array.isArray(value) ? value.join(', ') : String(value)
      }
      return draft
    }),
  }
}

// A count typed into a number field goes as a number; anything else goes as typed, so the API's own message
// about the field is what the operator reads.
function asNumber(text: string): number | string {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : text
}

function ruleFromDraft(draft: Draft): { ok: true; rule: Record<string, unknown> } | { ok: false; issues: ApiIssue[] } {
  let conditions: unknown
  if (draft.conditions.trim() !== '') {
    try {
      conditions = JSON.parse(draft.conditions)
    } catch {
      // the parser's message quotes the text it choked on, which is the operator's own input echoed back
      return { ok: false, issues: [{ path: 'conditions', message: 'expected JSON, for example {"all": [...]}' }] }
    }
  }
  const rule: Record<string, unknown> = {
    chainId: Number(draft.chainId),
    addresses: draft.addresses.split(/[\s,]+/).filter(Boolean),
    event: draft.event,
    confirmation: { mode: draft.confirmation },
    actions: draft.actions.map((action) => {
      const body: Record<string, unknown> = { type: action.type }
      for (const spec of ACTIONS[action.type]) {
        const text = action.fields[spec.name] ?? ''
        if (spec.optional && text.trim() === '') continue
        body[spec.name] = spec.list ? text.split(/[\s,]+/).filter(Boolean) : spec.number ? asNumber(text) : text
      }
      return body
    }),
  }
  if (conditions !== undefined) rule.conditions = conditions
  return { ok: true, rule }
}

function issueKeys(draft: Draft): string[] {
  const keys = ['chainId', 'addresses', 'event', 'confirmation', 'conditions', 'actions']
  draft.actions.forEach((action, index) => {
    keys.push(`actions.${index}`)
    for (const spec of ACTIONS[action.type]) keys.push(`actions.${index}.${spec.name}`)
  })
  return keys
}

// the field an issue belongs to is the longest rendered key it starts with, so `conditions.all.0.field` lands on
// the conditions box and `actions.0.to.1` on the first action's recipients
function keyFor(path: string, keys: string[]): string | undefined {
  let best: string | undefined
  for (const key of keys) {
    if ((path === key || path.startsWith(`${key}.`)) && (best === undefined || key.length > best.length)) best = key
  }
  return best
}

type Anchor = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }

function Field({
  label,
  name,
  issues,
  children,
}: {
  label: string
  name: string
  issues: ApiIssue[]
  children: (anchor: Anchor) => ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  const anchor: Anchor = issues.length > 0 ? { id, 'aria-describedby': errorId, 'aria-invalid': true } : { id }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(anchor)}
      {issues.length > 0 ? (
        <ul id={errorId} className="field-error">
          {issues.map((issue, index) => (
            <li key={index}>{issue.path === name ? issue.message : `${issue.path}: ${issue.message}`}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function RuleForm({ initial, onSaved }: { initial?: RuleBody; onSaved: (saved: RuleBody) => void }) {
  const [draft, setDraft] = useState(() => draftFromRule(initial))
  const [issues, setIssues] = useState<ApiIssue[]>([])
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  // state alone lets two clicks in the same tick both through, before the disabled button has rendered
  const inFlight = useRef(false)

  const keys = issueKeys(draft)
  const at = (key: string) => issues.filter((issue) => keyFor(issue.path, keys) === key)
  const unattached = issues.filter((issue) => keyFor(issue.path, keys) === undefined)

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function setAction(index: number, change: (action: ActionDraft) => ActionDraft) {
    setDraft((current) => ({ ...current, actions: current.actions.map((a, i) => (i === index ? change(a) : a)) }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    const built = ruleFromDraft(draft)
    if (!built.ok) {
      setIssues(built.issues)
      setProblem(undefined)
      return
    }
    inFlight.current = true
    setBusy(true)
    setIssues([])
    setProblem(undefined)
    try {
      // a patch carries the whole rule: the API compiles what it is sent and cannot compile a fragment
      const saved = initial
        ? await apiFetch<RuleBody>(`/v1/rules/${encodeURIComponent(initial.ruleId)}`, {
            method: 'PATCH',
            body: { ...built.rule, active: draft.active },
          })
        : await apiFetch<RuleBody>('/v1/rules', { method: 'POST', body: built.rule })
      onSaved(saved)
    } catch (err) {
      if (err instanceof ApiError && err.issues && err.issues.length > 0) {
        setIssues(err.issues)
      } else if (err instanceof ApiError && err.code === 'unknown_chain') {
        setIssues([{ path: 'chainId', message: err.message }])
      } else if (err instanceof ApiError) {
        setProblem(err.message)
      } else {
        // never the draft: a rule can name a secret parameter
        console.error('saving a rule failed', err)
        setProblem('Could not reach the API.')
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const chainIds = chains.some((chain) => String(chain.id) === draft.chainId)
    ? chains.map((chain) => chain.id)
    : [Number(draft.chainId), ...chains.map((chain) => chain.id)]

  return (
    <form onSubmit={submit} noValidate>
      {problem || unattached.length > 0 ? (
        <div role="alert">
          {problem ? <p>{problem}</p> : null}
          {unattached.length > 0 ? (
            <ul>
              {unattached.map((issue, index) => (
                <li key={index}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Field label="Chain" name="chainId" issues={at('chainId')}>
        {(anchor) => (
          <select {...anchor} value={draft.chainId} onChange={(e) => set('chainId', e.target.value)}>
            {chainIds.map((id) => (
              <option key={id} value={id}>
                {chainName(id)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Contract addresses (one per line)" name="addresses" issues={at('addresses')}>
        {(anchor) => (
          <textarea {...anchor} rows={3} value={draft.addresses} onChange={(e) => set('addresses', e.target.value)} />
        )}
      </Field>

      <Field label="Event signature" name="event" issues={at('event')}>
        {(anchor) => (
          <input {...anchor} type="text" value={draft.event} onChange={(e) => set('event', e.target.value)} />
        )}
      </Field>

      <Field label="Confirmation" name="confirmation" issues={at('confirmation')}>
        {(anchor) => (
          <select
            {...anchor}
            value={draft.confirmation}
            onChange={(e) => set('confirmation', e.target.value === 'fast' ? 'fast' : 'finalized')}
          >
            <option value="finalized">finalized</option>
            <option value="fast">fast</option>
          </select>
        )}
      </Field>

      <Field label="Conditions (JSON, optional)" name="conditions" issues={at('conditions')}>
        {(anchor) => (
          <textarea
            {...anchor}
            rows={5}
            spellCheck={false}
            value={draft.conditions}
            onChange={(e) => set('conditions', e.target.value)}
          />
        )}
      </Field>

      {draft.actions.map((action, index) => {
        const actionIssues = at(`actions.${index}`)
        return (
          <fieldset key={index}>
            <legend>{`Action ${index + 1}`}</legend>
            {actionIssues.length > 0 ? (
              <ul className="field-error">
                {actionIssues.map((issue, i) => (
                  <li key={i}>{`${issue.path}: ${issue.message}`}</li>
                ))}
              </ul>
            ) : null}
            <Field label={`Action ${index + 1} type`} name={`actions.${index}.type`} issues={[]}>
              {(anchor) => (
                <select
                  {...anchor}
                  value={action.type}
                  onChange={(e) => setAction(index, () => emptyAction(e.target.value as ActionType))}
                >
                  {ACTION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {ACTIONS[action.type].map((spec) => (
              <Field
                key={spec.name}
                label={spec.label}
                name={`actions.${index}.${spec.name}`}
                issues={at(`actions.${index}.${spec.name}`)}
              >
                {(anchor) => (
                  <input
                    {...anchor}
                    type="text"
                    value={action.fields[spec.name] ?? ''}
                    onChange={(e) =>
                      setAction(index, (a) => ({ ...a, fields: { ...a.fields, [spec.name]: e.target.value } }))
                    }
                  />
                )}
              </Field>
            ))}
            <button
              type="button"
              onClick={() =>
                set(
                  'actions',
                  draft.actions.filter((_, i) => i !== index),
                )
              }
            >
              {`Remove action ${index + 1}`}
            </button>
          </fieldset>
        )
      })}
      {at('actions').length > 0 ? (
        <ul className="field-error">
          {at('actions').map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      <p>
        <button
          type="button"
          disabled={draft.actions.length >= MAX_ACTIONS}
          onClick={() => set('actions', [...draft.actions, emptyAction('webhook')])}
        >
          Add action
        </button>
      </p>

      {initial ? (
        <p>
          <label>
            <input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} /> Active
          </label>
        </p>
      ) : null}

      <button type="submit" disabled={busy}>
        {initial ? 'Save rule' : 'Create rule'}
      </button>
    </form>
  )
}
