import type { Account, Harness, HeadsDispatch } from './dispatch-config.ts'
import { asRecord } from '#app/command-validation.ts'
import { harnessControls } from './controls.ts'
import { AGENT_FLAG } from './model.ts'

// The one document Settings, the CLI and Hydra read and change: heads dispatch and its accounts.
export interface DispatchDocument extends HeadsDispatch {
  accounts: Record<string, Account>
}

export interface DispatchIssue {
  path: string
  level: 'error' | 'warning'
  problem: string
}

export interface DispatchChange {
  path: string
  before?: unknown
  after?: unknown
}

type Fields = Record<string, unknown>
type Report = ({
  segments,
  problem,
}: {
  segments: string[]
  problem: string
}) => void

export const HARNESSES: readonly Harness[] = [
  'claude',
  'codex',
]
const HOSTED_PROVIDER: Record<Harness, string> = {
  claude: 'claude-code',
  codex: 'codex',
}
export const NAME = /^[a-z][a-z0-9:._-]{0,79}$/
const NAME_RULE = 'names use lowercase letters, digits, colon, dot, underscore and dash'
const DOCUMENT_FIELDS = [
  'rules',
  'default',
  'main',
  'workers',
  'projects',
  'accounts',
]
const RULE_FIELDS = [
  'when',
  'candidates',
]
const CANDIDATE_FIELDS = [
  'harness',
  'model',
  'effort',
  'mode',
  'fast',
]
const ACCOUNT_FIELDS = [
  'provider',
  'folder',
]

// Claude Code takes a 1M-context suffix on any model it lists, such as opus[1m].
export const ONE_MILLION = /\[1m\]$/

export const offered = ({
  harness,
  model,
  available,
}: {
  harness: Harness
  model: string
  available: string[]
}) => available.includes(harness === 'claude' ? model.replace(
  ONE_MILLION,
  '',
) : model)

export const pointer = ({ segments }: { segments: string[] }) => segments
  .map(segment => `/${segment.replaceAll(
    '~',
    '~0',
  ).replaceAll(
    '/',
    '~1',
  )}`)
  .join('')

// Effort and permission values each harness takes, as the composer offers them.
export function harnessValues({
  harness,
  setting,
}: {
  harness: Harness
  setting: 'effort' | 'mode'
}): string[] {
  const controls = harnessControls({
    provider: HOSTED_PROVIDER[harness],
    hosted: true,
  })?.controls ?? []

  return controls.find(control => control.setting === setting)?.options
    .map(option => option.value) ?? []
}

function fieldsOf({
  value,
  allowed,
  segments,
  what,
  error,
}: {
  value: unknown
  allowed: string[]
  segments: string[]
  what: string
  error: Report
}): Fields | undefined {
  const fields = asRecord({ value })

  if (!fields) {
    error({
      segments,
      problem: `${what} must be an object`,
    })

    return undefined
  }

  for (const key of Object.keys(fields).filter(key => !allowed.includes(key))) {
    error({
      segments: [
        ...segments,
        key,
      ],
      problem: `unknown field; ${what} takes ${allowed.join(', ')}`,
    })
  }

  return fields
}

function checkCandidates({
  value,
  segments,
  catalog,
  values = true,
  error,
  warn,
}: {
  value: unknown
  segments: string[]
  catalog?: Partial<Record<Harness, string[]>>
  values?: boolean
  error: Report
  warn: Report
}): void {
  if (!Array.isArray(value)) {
    error({
      segments,
      problem: 'candidates must be a list',
    })

    return
  }

  if (!value.length) {
    error({
      segments,
      problem: 'needs at least one candidate',
    })
  }

  value.forEach((
    raw,
    index,
  ) => {
    const at = [
      ...segments,
      String(index),
    ]
    const candidate = fieldsOf({
      value: raw,
      allowed: CANDIDATE_FIELDS,
      segments: at,
      what: 'a candidate',
      error,
    })

    if (!candidate) {
      return
    }

    const harness = candidate.harness as Harness

    if (!HARNESSES.includes(harness)) {
      error({
        segments: [
          ...at,
          'harness',
        ],
        problem: 'harness must be claude or codex',
      })

      return
    }

    for (const key of [
      'model',
      'effort',
      'mode',
    ] as const) {
      const field = candidate[key]

      if (field === undefined) {
        continue
      }

      if (typeof field !== 'string' || !AGENT_FLAG.test(field)) {
        error({
          segments: [
            ...at,
            key,
          ],
          problem: `${key} has characters a harness flag cannot take`,
        })
        continue
      }

      const allowed = key === 'model' || !values ? [] : harnessValues({
        harness,
        setting: key,
      })

      if (allowed.length && !allowed.includes(field)) {
        error({
          segments: [
            ...at,
            key,
          ],
          problem: `${harness} takes ${key} ${allowed.join(', ')}`,
        })
      }

      const available = catalog?.[harness]

      if (key === 'model' && available?.length && !offered({
        harness,
        model: field,
        available,
      })) {
        warn({
          segments: [
            ...at,
            key,
          ],
          problem: `${harness} does not offer model ${field} now`,
        })
      }
    }

    if (candidate.fast !== undefined && typeof candidate.fast !== 'boolean') {
      error({
        segments: [
          ...at,
          'fast',
        ],
        problem: 'fast must be true or false',
      })
    }
  })
}

function checkOrder({
  value,
  segments,
  accounts,
  error,
}: {
  value: unknown
  segments: string[]
  accounts?: Fields
  error: Report
}): void {
  const order = fieldsOf({
    value,
    allowed: [...HARNESSES],
    segments,
    what: 'an account order',
    error,
  })

  for (const [
    harness,
    names,
  ] of Object.entries(order ?? {})) {
    const at = [
      ...segments,
      harness,
    ]

    if (!Array.isArray(names)) {
      error({
        segments: at,
        problem: 'an account order is a list of account names',
      })
      continue
    }

    names.forEach((
      name,
      index,
    ) => {
      const problem = accountProblem({
        name,
        harness: harness as Harness,
        accounts,
      }) ?? (names.indexOf(name) < index ? `${String(name)} is listed twice` : undefined)

      if (problem) {
        error({
          segments: [
            ...at,
            String(index),
          ],
          problem,
        })
      }
    })
  }
}

// With no registered accounts, workers run on each harness's own login, so names are not checked.
function accountProblem({
  name,
  harness,
  accounts,
}: {
  name: unknown
  harness?: Harness
  accounts?: Fields
}): string | undefined {
  if (typeof name !== 'string' || !NAME.test(name)) {
    return NAME_RULE
  }

  if (!accounts || !Object.keys(accounts).length) {
    return undefined
  }

  const account = Object.hasOwn(
    accounts,
    name,
  ) ? asRecord({ value: accounts[name] }) : undefined

  if (!account) {
    return `${name} is not a registered account`
  }

  return harness && account.provider !== harness ? `${name} is a ${String(account.provider)} account` : undefined
}

function checkAccounts({
  value,
  exists,
  error,
  warn,
}: {
  value: unknown
  exists?({ folder }: { folder: string }): boolean
  error: Report
  warn: Report
}): Fields | undefined {
  const accounts = fieldsOf({
    value,
    allowed: Object.keys(asRecord({ value }) ?? {}),
    segments: ['accounts'],
    what: 'accounts',
    error,
  })

  for (const [
    name,
    raw,
  ] of Object.entries(accounts ?? {})) {
    const at = [
      'accounts',
      name,
    ]
    const account = fieldsOf({
      value: raw,
      allowed: ACCOUNT_FIELDS,
      segments: at,
      what: 'an account',
      error,
    })

    if (!NAME.test(name)) {
      error({
        segments: at,
        problem: NAME_RULE,
      })
    }

    if (!account) {
      continue
    }

    if (!HARNESSES.includes(account.provider as Harness)) {
      error({
        segments: [
          ...at,
          'provider',
        ],
        problem: 'provider must be claude or codex',
      })
    }

    const folder = account.folder

    if (typeof folder !== 'string' || !(folder.startsWith('/') || folder.startsWith('~/'))) {
      error({
        segments: [
          ...at,
          'folder',
        ],
        problem: 'needs an absolute login folder or ~/path',
      })
    } else if (exists && !exists({ folder })) {
      warn({
        segments: [
          ...at,
          'folder',
        ],
        problem: `login folder ${folder} does not exist`,
      })
    }
  }

  return accounts
}

// Shape and characters only, for a start override whose harness is not chosen yet.
export function candidateIssues({ value }: { value: unknown }): DispatchIssue[] {
  const issues: DispatchIssue[] = []

  const error: Report = ({
    segments,
    problem,
  }) => {
    issues.push({
      path: pointer({ segments }),
      level: 'error',
      problem,
    })
  }

  checkCandidates({
    value,
    segments: [],
    values: false,
    error,
    warn: () => {},
  })

  return issues
}

// A harness has workers when its own order or any project's order lists an account.
function staffed({
  harness,
  fields,
}: {
  harness: unknown
  fields: Fields
}): boolean {
  const orders = [
    fields.workers,
    ...Object.values(asRecord({ value: fields.projects }) ?? {}),
  ]

  return orders.some(order => {
    const names = asRecord({ value: order })?.[String(harness)]

    return Array.isArray(names) && names.length > 0
  })
}

// Every problem at once, each at its JSON pointer; errors block a save, warnings do not.
export function checkDispatch({
  document,
  catalog,
  exists,
}: {
  document: unknown
  catalog?: Partial<Record<Harness, string[]>>
  exists?({ folder }: { folder: string }): boolean
}): DispatchIssue[] {
  const issues: DispatchIssue[] = []

  const report = ({ level }: { level: DispatchIssue['level'] }): Report => ({
    segments,
    problem,
  }) => {
    issues.push({
      path: pointer({ segments }),
      level,
      problem,
    })
  }

  const error = report({ level: 'error' })
  const warn = report({ level: 'warning' })
  const fields = fieldsOf({
    value: document,
    allowed: DOCUMENT_FIELDS,
    segments: [],
    what: 'heads dispatch',
    error,
  })

  if (!fields) {
    return issues
  }

  const accounts = fields.accounts === undefined ? undefined : checkAccounts({
    value: fields.accounts,
    exists,
    error,
    warn,
  })
  const rules = fields.rules === undefined ? {} : fieldsOf({
    value: fields.rules,
    allowed: Object.keys(asRecord({ value: fields.rules }) ?? {}),
    segments: ['rules'],
    what: 'rules',
    error,
  }) ?? {}

  for (const [
    name,
    raw,
  ] of Object.entries(rules)) {
    const at = [
      'rules',
      name,
    ]
    const rule = fieldsOf({
      value: raw,
      allowed: RULE_FIELDS,
      segments: at,
      what: 'a rule',
      error,
    })

    if (!NAME.test(name) || name === 'default') {
      error({
        segments: at,
        problem: name === 'default' ? 'default is its own candidate list, not a rule' : NAME_RULE,
      })
    }

    if (!rule) {
      continue
    }

    if (typeof rule.when !== 'string' || !rule.when.trim()) {
      error({
        segments: [
          ...at,
          'when',
        ],
        problem: 'needs a plain-language when',
      })
    }

    checkCandidates({
      value: rule.candidates,
      segments: [
        ...at,
        'candidates',
      ],
      catalog,
      error,
      warn,
    })
    const listed = Array.isArray(rule.candidates) ? rule.candidates as unknown[] : []

    if (accounts && Object.keys(accounts).length && listed.length
      && !listed.some(candidate => staffed({
        harness: asRecord({ value: candidate })?.harness,
        fields,
      }))) {
      warn({
        segments: at,
        problem: 'no candidate has a worker account, so this rule cannot start',
      })
    }
  }

  if (fields.default !== undefined) {
    checkCandidates({
      value: fields.default,
      segments: ['default'],
      catalog,
      error,
      warn,
    })
  }

  if (fields.main !== undefined) {
    const problem = accountProblem({
      name: fields.main,
      accounts,
    })

    if (problem) {
      error({
        segments: ['main'],
        problem,
      })
    }
  }

  if (fields.workers !== undefined) {
    checkOrder({
      value: fields.workers,
      segments: ['workers'],
      accounts,
      error,
    })
  }

  const projects = fields.projects === undefined ? {} : fieldsOf({
    value: fields.projects,
    allowed: Object.keys(asRecord({ value: fields.projects }) ?? {}),
    segments: ['projects'],
    what: 'projects',
    error,
  }) ?? {}

  for (const [
    path,
    order,
  ] of Object.entries(projects)) {
    const at = [
      'projects',
      path,
    ]

    if (!path.startsWith('/')) {
      error({
        segments: at,
        problem: 'project overrides use absolute project paths',
      })
    }

    checkOrder({
      value: order,
      segments: at,
      accounts,
      error,
    })
  }

  return issues
}

// RFC 7386: an object merges key by key, null removes a key, and anything else replaces the value.
export function mergePatch({
  target,
  patch,
}: {
  target: unknown
  patch: unknown
}): unknown {
  const changes = asRecord({ value: patch })

  if (!changes) {
    return structuredClone(patch)
  }

  const result: Fields = structuredClone(asRecord({ value: target }) ?? {})

  for (const [
    key,
    value,
  ] of Object.entries(changes)) {
    if (value === null) {
      delete result[key]
    } else {
      result[key] = mergePatch({
        target: result[key],
        patch: value,
      })
    }
  }

  return result
}

const sorted = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => sorted({ value: item }))
  }

  const fields = asRecord({ value })

  return fields ? Object.fromEntries(Object.keys(fields).sort()
    .map(key => [
      key,
      sorted({ value: fields[key] }),
    ])) : value
}

// Key order never counts as a change.
export const canonical = ({ value }: { value: unknown }) => JSON.stringify(sorted({ value }))

// The values a patch changes, each at the deepest path the patch names.
export function patchChanges({
  document,
  patch,
  segments = [],
}: {
  document: unknown
  patch: unknown
  segments?: string[]
}): DispatchChange[] {
  const changes = asRecord({ value: patch })

  if (!changes) {
    return []
  }

  const current = asRecord({ value: document })

  return Object.entries(changes).flatMap(([
    key,
    value,
  ]) => {
    const at = [
      ...segments,
      key,
    ]
    const before = current && Object.hasOwn(
      current,
      key,
    ) ? current[key] : undefined

    if (asRecord({ value }) && asRecord({ value: before })) {
      return patchChanges({
        document: before,
        patch: value,
        segments: at,
      })
    }

    const after = value === null ? undefined : mergePatch({
      target: before,
      patch: value,
    })

    return canonical({ value: before }) === canonical({ value: after }) ? [] : [
      {
        path: pointer({ segments: at }),
        before,
        after,
      },
    ]
  })
}

// A change is out of date once any value it replaces is no longer what it saw.
export function outOfDate({
  document,
  changes,
}: {
  document: unknown
  changes: DispatchChange[]
}): boolean {
  return changes.some(change => canonical({
    value: valueAt({
      document,
      path: change.path,
    }),
  }) !== canonical({ value: change.before }))
}

function valueAt({
  document,
  path,
}: {
  document: unknown
  path: string
}): unknown {
  let value = document

  for (const segment of path.split('/').slice(1)) {
    const key = segment.replaceAll(
      '~1',
      '/',
    ).replaceAll(
      '~0',
      '~',
    )
    const fields = asRecord({ value })
    value = fields && Object.hasOwn(
      fields,
      key,
    ) ? fields[key] : undefined
  }

  return value
}
