import { saveOrPropose, resolveProposal } from './dispatch-proposals.ts'
import { existsSync } from 'node:fs'
import { TEMPLATE_NUDGE } from '#hydra/digest.ts'
import { isDeepStrictEqual } from 'node:util'
import { WRITE, guard, parse, required, meta, type Output } from '#app/cli-support.ts'
import { runsInBypass } from '#hydra/hydra-session.ts'
import { loadHydra, requireHydra } from '#app/store.ts'
import { withRegistryLock } from '#store/storage.ts'
import { candidates, configPath, effectiveDispatch, invalid, legacyDispatch, name, parseAccounts, parseDispatch, onTemplate, readConfig, readTemplate, templateRules, writeConfig, type Candidate, type Harness } from './dispatch-config.ts'

const OPTIONS = {
  ...WRITE,
  shared: { type: 'boolean' },
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
} as const

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
    return invalid({ message: 'Use rule propose set|remove|accounts with the change arguments' })
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
      values,
    })
  }

  const state = loadHydra({ hydraId }).state

  if (action === 'list') {
    return {
      hydraId,
      ...effectiveDispatch({
        hydraId,
        state,
      }),
      help: [
        'Hydra chooses a rule; task start --rule <name> selects a usable candidate without downgrading',
        ...(onTemplate({
          hydraId,
          state,
        }) ? [TEMPLATE_NUDGE] : []),
      ],
    }
  }

  const shared = Boolean(values.shared)
  const path = configPath({
    hydraId,
    shared,
  })

  if (!shared) {
    requireHydra({ hydraId })
  }

  return withRegistryLock({
    fn: () => {
      const before = parseDispatch({ value: readConfig({ path }) })
      const next = structuredClone(!shared && !existsSync(path)
        ? {
          ...legacyDispatch({ state }),
          ...before,
        } : before)
      const inherited = shared
        ? {
          ...templateRules(),
          workers: {},
          projects: {},
          ...before,
        }
        : effectiveDispatch({
          hydraId,
          state,
        }).dispatch

      if (action === 'migrate' || (action === 'init' && !shared)) {
        const hydraMustPropose = meta({ values }).actor === 'hydra' && !runsInBypass({ hydraId })

        if (propose || hydraMustPropose) {
          return invalid({ message: 'Propose a rule set, remove or accounts change instead' })
        }
      }

      if (action === 'init') {
        const accountPath = configPath({
          hydraId,
          accounts: true,
          shared,
        })

        if (!existsSync(path)) {
          writeConfig({
            path,
            value: readTemplate(),
          })
        }

        if (!existsSync(accountPath)) {
          writeConfig({
            path: accountPath,
            value: readTemplate({ accounts: true }),
            accounts: true,
          })
        }

        return {
          dispatch: path,
          accounts: accountPath,
          help: ['Edit login folders and remove accounts you do not use before starting workers; Pnyx stores no credentials'],
        }
      }

      if (action === 'migrate') {
        if (shared) {
          invalid({ message: 'legacy agents belong to a Hydra; migrate without --shared' })
        }

        if (existsSync(path)) {
          return { event: 'none: heads dispatch file already exists' }
        }

        writeConfig({
          path,
          value: legacyDispatch({ state }),
        })

        return { migrated: path }
      }

      if (action === 'accounts') {
        if (values.main !== undefined) {
          next.main = String(values.main)
        }

        if (values.provider !== undefined || values.order !== undefined) {
          const provider = required({
            value: values.provider as string | undefined,
            what: '--provider',
          })

          if (provider !== 'claude' && provider !== 'codex') {
            invalid({ message: '--provider must be claude or codex' })
          }

          const list = required({
            value: values.order as string | undefined,
            what: '--order (comma-separated account names)',
          }).split(',')
            .map(value => name({ value: value.trim() }))

          if (values.project) {
            const projects = inherited.projects
            next.projects = Object.keys(next.projects ?? {}).length
              ? next.projects ?? {} : structuredClone(projects)
            const project = String(values.project)
            next.projects[project] = {
              ...next.projects[project],
              [provider]: list,
            }
          } else {
            next.workers = Object.keys(next.workers ?? {}).length
              ? next.workers ?? {} : structuredClone(inherited.workers)
            next.workers[provider as Harness] = list
          }
        }
      } else if (action === 'set' || action === 'remove') {
        const key = name({
          value: required({
            value: positionals[1],
            what: 'rule name',
          }),
        })
        const effective = inherited
        const rules = Object.keys(next.rules ?? {}).length
          ? next.rules ?? {} : structuredClone(effective.rules)

        if (action === 'remove') {
          if (key === 'default') {
            invalid({ message: 'the default list cannot be removed; set its candidates instead' })
          }

          delete rules[key]
          next.rules = rules
        } else {
          const existing = key === 'default' ? effective.default : rules[key]?.candidates
          let list: Candidate[]

          if (values.candidates !== undefined) {
            try {
              list = candidates({ value: JSON.parse(String(values.candidates)) })
            } catch {
              return invalid({ message: '--candidates must be a JSON array of harness/model/effort candidates' })
            }
          } else {
            const agent: Candidate = {
              ...existing?.[0],
              harness: (values.harness ?? existing?.[0]?.harness ?? 'claude') as Harness,
            }

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

            list = candidates({ value: [agent] })
          }

          if (!list.length) {
            invalid({ message: 'a rule needs at least one candidate' })
          }

          if (key === 'default') {
            next.default = list
          } else {
            rules[key] = {
              when: String(values.when ?? rules[key]?.when ?? `Use for ${key} work`),
              candidates: list,
            }
            next.rules = rules
          }
        }
      } else {
        return invalid({ message: 'Use rule list, init, migrate, set, remove or accounts' })
      }

      if (isDeepStrictEqual(
        before,
        next,
      )) {
        return { event: 'none: unchanged' }
      }

      const proposal = saveOrPropose({
        hydraId,
        shared,
        value: next,
        values,
        propose,
        summary: `Rule ${action}${positionals[1] ? ` ${positionals[1]}` : ''}${shared ? ' (shared)' : ''}`,
      })

      if (proposal) {
        return proposal
      }

      return {
        saved: path,
        ...effectiveDispatch({
          hydraId,
          state,
        }),
      }
    },
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
  const state = loadHydra({ hydraId }).state

  if (action === 'list') {
    return {
      hydraId,
      accounts: effectiveDispatch({
        hydraId,
        state,
      }).accounts,
    }
  }

  const path = configPath({
    hydraId,
    accounts: true,
    shared: Boolean(values.shared),
  })

  if (!values.shared) {
    requireHydra({ hydraId })
  }

  return withRegistryLock({
    fn: () => {
      const file = parseAccounts({ value: readConfig({ path }) })

      if (!Object.keys(file.accounts).length && !values.shared) {
        const shared = configPath({
          hydraId,
          accounts: true,
          shared: true,
        })
        file.accounts = parseAccounts({ value: readConfig({ path: shared }) }).accounts
      }

      const key = name({
        value: required({
          value: positionals[1],
          what: 'account name',
        }),
      })

      if (action === 'remove') {
        delete file.accounts[key]
      } else if (action === 'set') {
        file.accounts[key] = {
          provider: required({
            value: values.provider as string | undefined,
            what: '--provider',
          }) as Harness,
          folder: required({
            value: values.folder as string | undefined,
            what: '--folder',
          }),
        }
      } else {
        return invalid({ message: 'Use account list, set or remove' })
      }

      const proposal = saveOrPropose({
        hydraId,
        shared: Boolean(values.shared),
        accounts: true,
        value: file,
        values,
        propose,
        summary: `Account ${action} ${key}${values.shared ? ' (shared)' : ''}`,
      })

      if (proposal) {
        return proposal
      }

      return {
        saved: path,
        accounts: effectiveDispatch({
          hydraId,
          state,
        }).accounts,
      }
    },
  })
}

export const dispatchCommands = {
  rule: guard({ handler: ruleCommand }),
  account: guard({ handler: accountCommand }),
}
export const DISPATCH_HELP = {
  rule: `usage: pnyx-axi rule list|init|migrate [--shared]
pnyx-axi rule set <name> --when "<work description>" --candidates '<JSON array>' [--shared]
pnyx-axi rule set <name> [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--fast on|off|default]
pnyx-axi rule propose set|remove|accounts <same arguments>
pnyx-axi rule confirm <token> --confirm <token> | dismiss <token>
pnyx-axi rule remove <name> [--shared]
pnyx-axi rule accounts [--main <account>] [--provider claude|codex --order <account,account>] [--project <absolute path>] [--shared]
Empty sections inherit the shared file. Single-candidate flags replace a rule's candidate list. rule migrate preserves old agents as rules without changing the event log.`,
  account: `usage: pnyx-axi account list
pnyx-axi account set <name> --provider claude|codex --folder <login folder> [--shared]
pnyx-axi account propose set|remove <same arguments>
pnyx-axi account remove <name> [--shared]
Only login folders are stored. Account order is set through rule accounts.`,
}
