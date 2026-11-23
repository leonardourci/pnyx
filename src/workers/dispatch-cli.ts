import { readInput } from '#app/request-context.ts'
import { TEMPLATE_NUDGE } from '#titan/digest.ts'
import { WRITE, guard, parse, required, meta, type Output } from '#app/cli-support.ts'
import { ApplyError } from '#app/apply/schema.ts'
import { parseApplyJson } from '#app/apply/json.ts'
import { loadTitan, requireTitan } from '#app/store.ts'
import { withRegistryLock } from '#store/storage.ts'
import { applyDispatch, DISPATCH_HELP_LINE, dispatchIssues, dispatchRevision, parseEnvelope, proposalStatus, resolveProposal } from './dispatch-apply.ts'
import { harnessValues, HARNESSES, NAME, NAME_RULE, type DispatchDocument } from './dispatch-check.ts'
import { candidates, effectiveDispatch, initConfig, invalid, lockedDocument, onTemplate, savedDocument, type Account, type AccountOrder, type Candidate, type Harness } from './dispatch-config.ts'
import { startsNow } from './dispatch.ts'
import { storedOffers } from './model-catalog.ts'
import { accountRegistration } from './account-choice.ts'

const OPTIONS = {
  ...WRITE,
  when: { type: 'string' },
  candidates: { type: 'string' },
  harness: { type: 'string' },
  account: { type: 'string' },
  label: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  mode: { type: 'string' },
  fast: { type: 'string' },
  main: { type: 'string' },
  provider: { type: 'string' },
  order: { type: 'string' },
  project: { type: 'string' },
  folder: { type: 'string' },
  file: { type: 'string' },
  json: { type: 'string' },
  check: { type: 'boolean' },
  propose: { type: 'boolean' },
} as const

type Values = Record<string, string | boolean | undefined>

const EXAMPLE = {
  version: 1,
  expected: { revision: 3 },
  patch: {
    rules: {
      build: {
        candidates: [
          {
            harness: 'claude',
            model: 'claude-opus-5-5',
            effort: 'high',
          },
          {
            harness: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'high',
          },
        ],
      },
      docs: null,
    },
    accounts: {
      'codex:work': {
        provider: 'codex',
        folder: '~/.codex-work',
      },
    },
    workers: { codex: ['codex:work'] },
  },
}

function checkedName({ value }: { value: string }): string {
  if (!NAME.test(value)) {
    invalid({ message: NAME_RULE })
  }

  return value
}

async function apply({
  hydraId,
  patch,
  values,
  propose,
  summary,
}: {
  hydraId: string
  patch: Record<string, unknown>
  values: Values
  propose: boolean
  summary: string
}): Promise<Output> {
  return await applyDispatch({
    hydraId,
    envelope: {
      version: 1,
      patch,
    },
    meta: meta({ values }),
    check: Boolean(values.check),
    proposeIt: propose,
    summary,
  })
}

// Single-candidate flags edit a rule's first candidate and keep its fallbacks.
function candidateList({
  values,
  existing,
}: {
  values: Values
  existing: Candidate[]
}): Candidate[] {
  if (values.candidates !== undefined) {
    let parsed: unknown

    try {
      parsed = JSON.parse(String(values.candidates))
    } catch {
      return invalid({ message: '--candidates must be a JSON array of harness/model/effort candidates' })
    }

    return candidates({ value: parsed })
  }

  const first = existing[0]
  const harness = (values.harness ?? first?.harness ?? 'claude') as Harness
  const agent: Candidate = first?.harness === harness ? structuredClone(first) : { harness }

  for (const field of [
    'account',
    'model',
    'effort',
    'mode',
  ] as const) {
    if (values[field] === '') {
      delete agent[field]
    } else if (values[field] !== undefined) {
      agent[field] = String(values[field])
    }
  }

  if (values.fast === 'default') {
    delete agent.fast
  } else if (values.fast !== undefined) {
    if (values.fast !== 'on' && values.fast !== 'off') {
      invalid({ message: '--fast must be on, off or default' })
    }

    agent.fast = values.fast === 'on'
  }

  return [
    agent,
    ...existing.slice(1),
  ]
}

// A removed account leaves every account order too; the main account still needs a new main first.
function withoutAccount({
  document,
  name,
}: {
  document: DispatchDocument
  name: string
}): Record<string, unknown> {
  const without = ({ order }: { order: AccountOrder }) => Object.fromEntries(Object.entries(order)
    .filter(([
      , names,
    ]) => names?.includes(name))
    .map(([
      harness,
      names,
    ]) => {
      const kept = names!.filter(item => item !== name)

      return [
        harness,
        kept.length ? kept : null,
      ]
    }))

  return {
    accounts: { [name]: null },
    workers: without({ order: document.workers }),
    projects: Object.fromEntries(Object.entries(document.projects).map(([
      path,
      order,
    ]) => [
      path,
      without({ order }),
    ])),
  }
}

// A terminal reads the envelope from a file or stdin; the page, which has neither, sends it inline.
function readEnvelope({ values }: { values: Values }): unknown {
  if (values.file !== undefined && values.json !== undefined) {
    return invalid({ message: 'Use --file or --json, not both' })
  }

  const file = values.json === undefined ? required({
    value: values.file as string | undefined,
    what: '--file <path|-> or --json <envelope>',
  }) : undefined

  try {
    return parseApplyJson({
      contents: file === undefined ? String(values.json) : readInput({ file: file }),
    })
  } catch (error) {
    if (error instanceof ApplyError) {
      throw error
    }

    throw new ApplyError({
      errors: [
        {
          operation: null,
          path: file === undefined ? '/json' : '/file',
          code: 'VALIDATION_ERROR',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
      help: DISPATCH_HELP_LINE,
    })
  }
}

function parsedDocument({ json }: { json?: string }): unknown {
  if (json === undefined) {
    return undefined
  }

  try {
    return JSON.parse(json) as unknown
  } catch {
    return invalid({ message: '--json must be a heads dispatch document; run `othrys rule schema`' })
  }
}

async function ruleCommand({ args }: { args: string[] }): Promise<Output> {
  const propose = args[0] === 'propose'
  args = propose ? args.slice(1) : args
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: OPTIONS,
    positionals: 2,
  })
  const action = positionals[0] ?? 'list'

  if (propose && ![
    'set',
    'remove',
    'accounts',
  ].includes(action)) {
    return invalid({ message: 'Use rule propose set|remove|accounts with the change arguments, or rule apply --propose' })
  }

  if (action === 'confirm' || action === 'dismiss') {
    return await resolveProposal({
      hydraId,
      action,
      token: required({
        value: positionals[1],
        what: 'proposal token',
      }),
      meta: meta({ values }),
    })
  }

  if (action === 'list') {
    const { state } = loadTitan({ hydraId })
    const help = [
      'Titan chooses a rule; task start --rule <name> selects a usable candidate without downgrading',
      'Run `othrys rule show` for the editable document and its revision',
    ]

    if (onTemplate()) {
      help.push(TEMPLATE_NUDGE)
    }

    return {
      hydraId,
      ...effectiveDispatch(),
      revision: dispatchRevision(),
      proposals: proposalStatus({ state }),
      help,
    }
  }

  if (action === 'show') {
    // Both under the lock, so a patch built on this document never carries a newer revision.
    const {
      document,
      revision,
    } = withRegistryLock({
      fn: () => ({
        document: lockedDocument(),
        revision: dispatchRevision(),
      }),
    })

    return {
      revision,
      document,
      issues: dispatchIssues({ document }).map(found => `${found.level} ${found.path}: ${found.problem}`),
      help: ['Edit dispatch rules in Settings'],
    }
  }

  if (action === 'schema') {
    return {
      document: 'rules{<name>:{when,candidates[]}}, default[], main, workers{claude[],codex[]}, projects{<absolute path>:{claude[],codex[]}}, accounts{<name>:{provider,folder,label?}}',
      required: 'rules, workers, projects and accounts are objects that may be empty; default lists at least one candidate; main is optional',
      names: 'main and account orders name registered accounts of the matching provider; with no registered accounts, only claude:default and codex:default, the harnesses\' own logins',
      candidate: '{harness, account?, model?, effort?, mode?, fast?}',
      uniqueness: 'Each provider and account pair appears once per rule; a candidate without an account is its own pair',
      values: Object.fromEntries(HARNESSES.map(harness => [
        harness,
        {
          effort: harnessValues({
            harness,
            setting: 'effort',
          }),
          mode: harnessValues({
            harness,
            setting: 'mode',
          }),
        },
      ])),
      apply: '{version:1, expected?:{revision}, patch}; patch is a JSON Merge Patch (RFC 7386): name only what changes, null removes a key, and a list replaces the whole list',
      example: JSON.stringify(EXAMPLE),
      help: ['Error paths point into the document the patch produces'],
    }
  }

  if (action === 'apply') {
    const envelope = parseEnvelope({ value: readEnvelope({ values }) })

    return await applyDispatch({
      hydraId,
      envelope,
      meta: meta({ values }),
      check: Boolean(values.check),
      proposeIt: Boolean(values.propose),
      summary: `Apply heads dispatch changes to ${Object.keys(envelope.patch).join(', ')}`,
    })
  }

  if (action === 'now') {
    return {
      now: await startsNow({
        config: effectiveDispatch({
          document: parsedDocument({ json: values.json as string | undefined }),
        }),
        offers: storedOffers(),
      }),
      help: ['Each candidate takes the first account in its harness order with quota left; the highest known spendPriority starts, and a tie or unknown quota starts the first listed'],
    }
  }

  if (action === 'init') {
    return {
      ...initConfig({ meta: meta({ values }) }),
      help: ['Fix login folders and remove unused accounts in Settings before starting workers; Othrys stores no credentials'],
    }
  }

  requireTitan({ hydraId })
  const document = savedDocument()

  if (action === 'accounts') {
    const patch: Record<string, unknown> = {}

    if (values.main !== undefined) {
      patch.main = String(values.main)
    }

    if (values.provider !== undefined || values.order !== undefined) {
      const provider = required({
        value: values.provider as string | undefined,
        what: '--provider',
      }) as Harness

      if (!HARNESSES.includes(provider)) {
        invalid({ message: '--provider must be claude or codex' })
      }

      const order = {
        [provider]: required({
          value: values.order as string | undefined,
          what: '--order (comma-separated account names)',
        }).split(',')
          .map(value => checkedName({ value: value.trim() })),
      }

      if (values.project) {
        patch.projects = { [String(values.project)]: order }
      } else {
        patch.workers = order
      }
    }

    return await apply({
      hydraId,
      patch,
      values,
      propose,
      summary: 'Rule accounts',
    })
  }

  if (action !== 'set' && action !== 'remove') {
    return invalid({ message: 'Use rule list, show, schema, now, apply, init, set, remove or accounts' })
  }

  const key = checkedName({
    value: required({
      value: positionals[1],
      what: 'rule name',
    }),
  })

  if (action === 'remove' && key === 'default') {
    invalid({ message: 'the default list cannot be removed; set its candidates instead' })
  }

  const existing = key === 'default' ? document.default : document.rules[key]?.candidates ?? []
  let patch: Record<string, unknown>

  if (action === 'remove') {
    patch = { rules: { [key]: null } }
  } else if (key === 'default') {
    patch = {
      default: candidateList({
        values,
        existing,
      }),
    }
  } else {
    patch = {
      rules: {
        [key]: {
          when: String(values.when ?? document.rules[key]?.when ?? `Use for ${key} work`),
          candidates: candidateList({
            values,
            existing,
          }),
        },
      },
    }
  }

  return await apply({
    hydraId,
    patch,
    values,
    propose,
    summary: `Rule ${action} ${key}`,
  })
}

function accountFlags({ values }: { values: Record<string, unknown> }): Account {
  const account: Account = {
    provider: required({
      value: values.provider as string | undefined,
      what: '--provider',
    }) as Harness,
    folder: required({
      value: values.folder as string | undefined,
      what: '--folder',
    }),
  }

  if (values.label !== undefined) {
    account.label = String(values.label)
  }

  return account
}

async function accountCommand({ args }: { args: string[] }): Promise<Output> {
  const propose = args[0] === 'propose'
  args = propose ? args.slice(1) : args
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: OPTIONS,
    positionals: 2,
  })
  const action = positionals[0] ?? 'list'

  if (action === 'list') {
    return {
      hydraId,
      accounts: effectiveDispatch().accounts,
    }
  }

  requireTitan({ hydraId })
  const key = checkedName({
    value: required({
      value: positionals[1],
      what: 'account name',
    }),
  })

  if (action !== 'set' && action !== 'remove') {
    return invalid({ message: 'Use account list, set or remove' })
  }

  const patch: Record<string, unknown> = action === 'remove' ? withoutAccount({
    document: savedDocument(),
    name: key,
  }) : accountRegistration({
    effective: effectiveDispatch(),
    name: key,
    account: accountFlags({ values }),
  })

  return await apply({
    hydraId,
    patch,
    values,
    propose,
    summary: `Account ${action} ${key}`,
  })
}

export const dispatchCommands = {
  rule: guard({ handler: ruleCommand }),
  account: guard({ handler: accountCommand }),
}
