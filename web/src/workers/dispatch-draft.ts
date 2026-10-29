import { asRecord } from '#app/command-validation.ts'
import type { Candidate, Rule } from '#workers/dispatch-config.ts'
import { canonical, checkDispatch, patchChanges, pointer, type DispatchChange, type DispatchDocument, type DispatchIssue } from '#workers/dispatch-check.ts'

// Hydra's own agent: Settings edits it under Hydra's default agent, not in the workers' table.
export const HYDRA_RULE = 'hydra'

export const CANDIDATE_FIELDS = [
  'model',
  'effort',
  'mode',
  'fast',
] as const

export type CandidateField = (typeof CANDIDATE_FIELDS)[number]

export type DraftRule = Rule & { name: string }

// The table edits rules as a list, so a rule keeps its row while it is renamed and two rules may share a name until fixed.
export type Draft = Omit<DispatchDocument, 'rules'> & { rules: DraftRule[] }

// A rule's place in the draft, or the default list.
export type RuleAt = number | 'default'

const candidateList = ({ value }: { value: unknown }) => Array.isArray(value)
  && value.every(item => asRecord({ value: item }))

// Only a document whose rules and default are candidate lists fits the table; anything else stays in the JSON view.
export function toDraft({ document }: { document: unknown }): Draft | undefined {
  const fields = asRecord({ value: document })
  const rules = asRecord({ value: fields?.rules })

  if (!fields || !rules || !candidateList({ value: fields.default })) {
    return undefined
  }

  const list: Record<string, unknown>[] = Object.entries(rules).map(([
    name,
    rule,
  ]) => ({
    ...asRecord({ value: rule }),
    name,
  }))

  if (!list.every(rule => candidateList({ value: rule.candidates }))) {
    return undefined
  }

  return {
    ...fields,
    rules: list,
  } as unknown as Draft
}

export function documentOf({ draft }: { draft: Draft }): DispatchDocument {
  return {
    ...draft,
    rules: Object.fromEntries(draft.rules.map(({
      name,
      ...rule
    }) => [
      name,
      rule,
    ])),
  }
}

// Every problem the checker finds, plus a name two rules share, which a document cannot hold.
export function draftIssues({ draft }: { draft: Draft }): DispatchIssue[] {
  const names = draft.rules.map(rule => rule.name)
  const shared = [
    ...new Set(names.filter((
      name,
      index,
    ) => names.indexOf(name) < index)),
  ]

  return [
    ...shared.map(name => ({
      path: pointer({
        segments: [
          'rules',
          name,
        ],
      }),
      level: 'error' as const,
      problem: `two rules are named ${name}`,
    })),
    ...checkDispatch({ document: documentOf({ draft }) }),
  ]
}

// The JSON Merge Patch that turns before into after: a removed key is null, and a changed list is sent whole.
export function patchBetween({
  before,
  after,
}: {
  before: unknown
  after: unknown
}): Record<string, unknown> {
  const from = asRecord({ value: before }) ?? {}
  const to = asRecord({ value: after }) ?? {}
  const removed = Object.keys(from).filter(key => !Object.hasOwn(
    to,
    key,
  ))
    .map(key => [
      key,
      null,
    ])
  const changed = Object.entries(to).flatMap(([
    key,
    value,
  ]) => {
    const old = Object.hasOwn(
      from,
      key,
    ) ? from[key] : undefined

    if (asRecord({ value }) && asRecord({ value: old })) {
      const inner = patchBetween({
        before: old,
        after: value,
      })

      return Object.keys(inner).length ? [
        [
          key,
          inner,
        ],
      ] : []
    }

    return old === undefined || canonical({ value: old }) !== canonical({ value }) ? [
      [
        key,
        structuredClone(value),
      ],
    ] : []
  })

  return Object.fromEntries([
    ...removed,
    ...changed,
  ])
}

export const changesBetween = ({
  before,
  after,
}: {
  before: DispatchDocument
  after: unknown
}): DispatchChange[] => patchChanges({
  document: before,
  patch: patchBetween({
    before,
    after,
  }),
})

export function changeKind({ change }: { change: DispatchChange }): 'added' | 'removed' | 'changed' {
  if (change.before === undefined) {
    return 'added'
  }

  return change.after === undefined ? 'removed' : 'changed'
}

// The issues at a path, or also those under it.
export function issuesAt({
  issues,
  segments,
  under = false,
}: {
  issues: DispatchIssue[]
  segments: string[]
  under?: boolean
}): DispatchIssue[] {
  const path = pointer({ segments })

  return issues.filter(issue => issue.path === path || (under && issue.path.startsWith(`${path}/`)))
}

export const ruleSegments = ({ name }: { name: string }) => name === 'default' ? ['default'] : [
  'rules',
  name,
  'candidates',
]

// Each picker cell of a candidate: changed from the saved one at its place, and red while it holds an error.
export function candidateMarks({
  saved,
  candidate,
  issues,
  segments,
}: {
  saved?: Candidate
  candidate: Candidate
  issues: DispatchIssue[]
  segments: string[]
}): Record<CandidateField, {
  changed: boolean
  invalid: boolean
}> {
  const invalid = ({ fields }: { fields: string[] }) => fields.some(field => issuesAt({
    issues,
    segments: [
      ...segments,
      field,
    ],
  }).some(issue => issue.level === 'error'))
  const changed = ({ fields }: { fields: (keyof Candidate)[] }) => !saved
    || fields.some(field => saved[field] !== candidate[field])

  return Object.fromEntries(CANDIDATE_FIELDS.map(field => {
    const fields: (keyof Candidate)[] = field === 'model' ? [
      'harness',
      'model',
    ] : [field]

    return [
      field,
      {
        changed: changed({ fields }),
        invalid: invalid({ fields }),
      },
    ]
  })) as Record<CandidateField, {
    changed: boolean
    invalid: boolean
  }>
}

export const candidatesAt = ({
  draft,
  rule,
}: {
  draft: Draft
  rule: RuleAt
}) => rule === 'default' ? draft.default : draft.rules[rule]!.candidates

export function withCandidates({
  draft,
  rule,
  candidates,
}: {
  draft: Draft
  rule: RuleAt
  candidates: Candidate[]
}): Draft {
  if (rule === 'default') {
    return {
      ...draft,
      default: candidates,
    }
  }

  return withRule({
    draft,
    rule,
    change: { candidates },
  })
}

export function withRule({
  draft,
  rule,
  change,
}: {
  draft: Draft
  rule: number
  change: Partial<DraftRule>
}): Draft {
  return {
    ...draft,
    rules: draft.rules.map((
      item,
      index,
    ) => index === rule ? {
      ...item,
      ...change,
    } : item),
  }
}

const NEW_RULE = 'new-rule'

// A new rule starts on Claude Code's defaults and still needs its when before it saves.
export function withNewRule({ draft }: { draft: Draft }): Draft {
  const taken = new Set(draft.rules.map(rule => rule.name))
  let name = NEW_RULE

  for (let count = 2; taken.has(name); count++) {
    name = `${NEW_RULE}-${count}`
  }

  return {
    ...draft,
    rules: [
      ...draft.rules,
      {
        name,
        when: '',
        candidates: [{ harness: 'claude' }],
      },
    ],
  }
}

export function withoutRule({
  draft,
  rule,
}: {
  draft: Draft
  rule: number
}): Draft {
  return {
    ...draft,
    rules: draft.rules.filter((
      _,
      index,
    ) => index !== rule),
  }
}

// The JSON view's text as a document, or why it is not one.
export function parseDocument({ text }: { text: string }): {
  document?: unknown
  problem?: string
} {
  try {
    return { document: JSON.parse(text) as unknown }
  } catch (error) {
    return { problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export const formatted = ({ document }: { document: unknown }) => JSON.stringify(
  document,
  null,
  2,
)
