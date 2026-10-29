import { readFileSync } from 'node:fs'
import { TEMPLATE_NUDGE } from '#hydra/digest.ts'
import { WRITE, guard, parse, required, meta, type Output } from '#app/cli-support.ts'
import { ApplyError } from '#app/apply/schema.ts'
import { parseApplyJson } from '#app/apply/json.ts'
import { loadHydra, requireHydra } from '#app/store.ts'
import { applyDispatch, dispatchIssues, dispatchRevision, parseEnvelope, proposalStatus, resolveProposal } from './dispatch-apply.ts'
import { harnessValues, HARNESSES, NAME } from './dispatch-check.ts'
import { candidates, effectiveDispatch, initConfig, invalid, onTemplate, readDocument, type Candidate, type Harness } from './dispatch-config.ts'

const OPTIONS = {
  ...WRITE,
  when: { type: 'string' },
  candidates: { type: 'string' },
  harness: { type: 'string' },
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
    invalid({ message: 'names use lowercase letters, digits, colon, dot, underscore and dash' })
  }

  return value
}

function apply({
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
}): Output {
  return applyDispatch({
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
    try {
      return candidates({ value: JSON.parse(String(values.candidates)) })
    } catch {
      return invalid({ message: '--candidates must be a JSON array of harness/model/effort candidates' })
    }
  }

  const first = existing[0]
  const harness = (values.harness ?? first?.harness ?? 'claude') as Harness
  const agent: Candidate = first?.harness === harness ? structuredClone(first) : { harness }

  for (const field of [
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

function readPatchFile({ file }: { file: string }): unknown {
  try {
    return parseApplyJson({
      contents: readFileSync(
        file === '-' ? 0 : file,
        'utf8',
      ),
    })
  } catch (error) {
    if (error instanceof ApplyError) {
      throw error
    }

    throw new ApplyError({
      errors: [
        {
          operation: null,
          path: '/file',
          code: 'VALIDATION_ERROR',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    })
  }
}

function ruleCommand({ args }: { args: string[] }): Output {
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
    return resolveProposal({
      hydraId,
      action,
      token: required({
        value: positionals[1],
        what: 'proposal token',
      }),
      confirm: values.confirm as string | undefined,
      meta: meta({ values }),
    })
  }

  if (action === 'list') {
    const { state } = loadHydra({ hydraId })
    const help = [
      'Hydra chooses a rule; task start --rule <name> selects a usable candidate without downgrading',
      'Run `pnyx-axi rule show` for the editable document and its revision',
    ]

    if (onTemplate()) {
      help.push(TEMPLATE_NUDGE)
    }

    return {
      hydraId,
      ...effectiveDispatch(),
      proposals: proposalStatus({ state }),
      help,
    }
  }

  if (action === 'show') {
    const document = readDocument()
    const revision = dispatchRevision()

    return {
      revision,
      document,
      warnings: dispatchIssues({ document }).map(found => `${found.path}: ${found.problem}`),
      help: ['Change it with `pnyx-axi rule apply --file <patch.json> --check`, then without --check (Hydra: --propose)'],
    }
  }

  if (action === 'schema') {
    return {
      document: 'rules{<name>:{when,candidates[]}}, default[], main, workers{claude[],codex[]}, projects{<absolute path>:{claude[],codex[]}}, accounts{<name>:{provider,folder}}',
      candidate: '{harness, model?, effort?, mode?, fast?}',
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
    const envelope = parseEnvelope({
      value: readPatchFile({
        file: required({
          value: values.file as string | undefined,
          what: '--file <path|->',
        }),
      }),
    })

    return applyDispatch({
      hydraId,
      envelope,
      meta: meta({ values }),
      check: Boolean(values.check),
      proposeIt: Boolean(values.propose),
      summary: `Apply heads dispatch changes to ${Object.keys(envelope.patch).join(', ')}`,
    })
  }

  if (action === 'init') {
    return {
      ...initConfig(),
      help: ['Fix login folders and remove accounts you do not use with `pnyx-axi rule apply` before starting workers; Pnyx stores no credentials'],
    }
  }

  requireHydra({ hydraId })
  const document = readDocument()

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

    return apply({
      hydraId,
      patch,
      values,
      propose,
      summary: 'Rule accounts',
    })
  }

  if (action !== 'set' && action !== 'remove') {
    return invalid({ message: 'Use rule list, show, schema, apply, init, set, remove or accounts' })
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

  return apply({
    hydraId,
    patch,
    values,
    propose,
    summary: `Rule ${action} ${key}`,
  })
}

function accountCommand({ args }: { args: string[] }): Output {
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

  requireHydra({ hydraId })
  const key = checkedName({
    value: required({
      value: positionals[1],
      what: 'account name',
    }),
  })

  if (action !== 'set' && action !== 'remove') {
    return invalid({ message: 'Use account list, set or remove' })
  }

  return apply({
    hydraId,
    patch: {
      accounts: {
        [key]: action === 'remove' ? null : {
          provider: required({
            value: values.provider as string | undefined,
            what: '--provider',
          }),
          folder: required({
            value: values.folder as string | undefined,
            what: '--folder',
          }),
        },
      },
    },
    values,
    propose,
    summary: `Account ${action} ${key}`,
  })
}

export const dispatchCommands = {
  rule: guard({ handler: ruleCommand }),
  account: guard({ handler: accountCommand }),
}
export const DISPATCH_HELP = {
  rule: `usage: pnyx-axi rule list|show|schema|init
pnyx-axi rule apply --file <patch.json|-> [--check] [--propose] [--if-revision <revision>] [--event-id <id>]
pnyx-axi rule set <name> --when "<work description>" --candidates '<JSON array>'
pnyx-axi rule set <name> [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--fast on|off|default]
pnyx-axi rule propose set|remove|accounts <same arguments>
pnyx-axi rule confirm <token> --confirm <token> | dismiss <token>
pnyx-axi rule remove <name>
pnyx-axi rule accounts [--main <account>] [--provider claude|codex --order <account,account>] [--project <absolute path>]
Heads dispatch is one document every Hydra shares: rules, the default list, accounts, the main account and account orders. rule show prints it with its revision; rule schema lists every field and allowed value.
rule apply takes {"version":1,"expected":{"revision":<n>},"patch":{...}}, a JSON Merge Patch naming only what changes (null removes a key). It checks the whole result and saves all or nothing; --check previews the changes and warnings, and --propose asks the owner to confirm. Hydra proposes outside bypass.
set, remove and accounts are shortcuts for one patch. Single-candidate flags edit a rule's first candidate and keep its fallbacks. rule init copies the templates, taking login folders from CLAUDE_CONFIG_DIR and CODEX_HOME when set, and never overwrites a file.`,
  account: `usage: pnyx-axi account list
pnyx-axi account set <name> --provider claude|codex --folder <login folder>
pnyx-axi account propose set|remove <same arguments>
pnyx-axi account remove <name>
Only login folders are stored. Account order is set through rule accounts or rule apply. Removing an account that an order still names is refused.`,
}
