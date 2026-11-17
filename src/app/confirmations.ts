import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { join } from 'node:path'
import { WRITE, guard, meta, parse, required, type Output } from './cli-support.ts'
import { effectiveDispatch, type EffectiveDispatch } from '#workers/dispatch-config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { withWriter } from './writer.ts'
import { loadHydra } from './store.ts'
import { pnyxHome } from '#store/storage.ts'
import { SOURCE_CONDITIONS } from './source-conditions.ts'
import { requestCwd, IDENTITY } from '#app/request-context.ts'
import { memoryAgent, memoryAccessRevision } from '#memory/poleis.ts'

const exec = promisify(execFile)
const ENTRY = join(
  import.meta.dirname,
  '..',
  'cli',
  'pnyx-axi.' + (import.meta.filename.endsWith('.ts') ? 'ts' : 'js'),
)

interface Target {
  name: string
  args: string[]
  cwd: string
}

// Read before taking a Hydra writer, so the shared registry lock is never taken inside one.
const dispatchFor = ({ target }: { target: Target }) => target.name === 'rule' || target.name === 'account'
  ? effectiveDispatch()
  : undefined

function memoryRulesFor({ target }: { target: Target }): string | undefined {
  const memoryCommand = target.name === 'settings' || target.name === 'owner'
    || (target.name === 'project' && target.args[0] === 'move')
    || (target.name === 'hydra' && target.args.some(arg => /^--(?:polis|read-poleis)(?:=|$)/.test(arg)))

  return memoryCommand ? memoryAccessRevision() : undefined
}

function context({
  state,
  target,
  dispatch,
  memory,
}: {
  state: HydraState
  target: Target
  dispatch?: EffectiveDispatch
  memory?: string
}): string {
  const {
    name,
    args,
  } = target
  let ref = HYDRA_CARD

  if (name === 'agent') {
    ref = args[0] ?? ''
  }

  if (name === 'task') {
    ref = args[1] ?? ''
  }

  const card = ref ? state.cards[ref] ?? state.cards[state.keys[ref] ?? ''] : undefined

  return createHash('sha256').update(JSON.stringify({
    config: name === 'hydra' || name === 'setup' || memory ? state.config : undefined,
    projects: name === 'project' || name === 'owner' ? state.projects : undefined,
    dispatch,
    memory,
    card: card && {
      agent: card.agent,
      settings: card.settings,
      copy: card.copy,
      permissions: card.permissions,
    },
  }))
    .digest('hex')
}

export function proposeOwnerCommand({
  name,
  args,
  hydraId,
}: {
  name: string
  args: string[]
  hydraId: string
}): Output {
  const safe: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if ([
      '--hydra',
      '--actor',
      '--confirm',
      '--event-id',
    ].includes(arg)) {
      index++
      continue
    }

    if (/^--(hydra|actor|confirm|event-id)=/.test(arg)) {
      continue
    }

    safe.push(arg)
  }

  const token = randomUUID()
  const target: Target = {
    name,
    args: safe,
    cwd: requestCwd(),
  }
  const value = JSON.stringify(target)
  const summary = `Approve pnyx-axi ${name} ${safe.map(arg => JSON.stringify(arg)).join(' ')}`
  const dispatch = dispatchFor({ target })
  const memory = memoryRulesFor({ target })
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: {
          actor: 'hydra',
          at: new Date().toISOString(),
        },
        cardId: HYDRA_CARD,
        change: {
          type: 'hydra.dispatch-proposed',
          data: {
            token,
            kind: 'command',
            shared: false,
            before: context({
              state: writer.state,
              target,
              dispatch,
              memory,
            }),
            value,
            summary,
          },
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })

  return {
    confirmation: 'needed',
    token,
    action: summary,
    preview: {
      name,
      args: safe,
    },
    help: ['The owner can Confirm or Dismiss this question in Hydra’s chat'],
  }
}

export const approval = guard({
  handler: async ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: WRITE,
      positionals: 2,
    })
    const actor = meta({ values })

    if (actor.actor === 'hydra' || memoryAgent()) {
      throw new HydraError({
        message: 'Only the owner can answer an approval question',
        code: 'OWNER_ONLY',
      })
    }

    const action = positionals[0]
    const token = required({
      value: positionals[1],
      what: 'proposal token',
    })

    if (action !== 'confirm' && action !== 'dismiss') {
      throw new HydraError({
        message: 'Use approval confirm|dismiss <token> [--confirm <token>]',
        code: 'VALIDATION_ERROR',
      })
    }

    const asked = loadHydra({ hydraId }).state.dispatchProposals?.find(p => p.token === token)
    const dispatch = action === 'confirm' && asked?.kind === 'command'
      ? dispatchFor({ target: JSON.parse(asked.value) as Target })
      : undefined
    const memory = action === 'confirm' && asked?.kind === 'command'
      ? memoryRulesFor({ target: JSON.parse(asked.value) as Target }) : undefined
    const selected = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const proposal = writer.state.dispatchProposals?.find(p => p.token === token)

        if (!proposal || proposal.kind !== 'command') {
          return undefined
        }

        if (action === 'confirm' && proposal.status === 'applying') {
          throw new HydraError({
            message: 'This approved action is already applying; it will not run twice',
            code: 'CONFLICT',
          })
        }

        if (action === 'confirm' && proposal.status === 'failed') {
          throw new HydraError({
            message: 'Inspect the failed action before asking Hydra for a new question',
            code: 'CONFLICT',
          })
        }

        if (action === 'confirm' && values.confirm !== token) {
          return proposal
        }

        if (action === 'confirm' && context({
          state: writer.state,
          target: JSON.parse(proposal.value) as Target,
          dispatch,
          memory,
        }) !== proposal.before) {
          throw new HydraError({
            message: 'The target changed; dismiss this question and ask Hydra to propose it again',
            code: 'CONFLICT',
          })
        }

        const decision = hydraEvent({
          state: writer.state,
          meta: actor,
          cardId: HYDRA_CARD,
          change: action === 'confirm' ? {
            type: 'hydra.dispatch-progress',
            data: {
              token,
              status: 'applying',
            },
          }
            : {
              type: 'hydra.dispatch-resolved',
              data: {
                token,
                action: 'dismissed',
              },
            },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }

        return proposal
      },
    })

    if (!selected) {
      return { event: 'none: proposal already resolved or missing' }
    }

    if (action === 'dismiss') {
      return {
        proposal: token,
        state: 'dismissed',
      }
    }

    if (values.confirm !== token) {
      return {
        confirmation: 'needed',
        token,
        action: selected.summary,
        preview: JSON.parse(selected.value),
      }
    }

    const target = JSON.parse(selected.value) as Target
    let output: string
    const ownerEnv = { ...process.env }

    for (const name of IDENTITY) {
      delete ownerEnv[name]
    }

    ownerEnv.PNYX_HOME = pnyxHome()
    ownerEnv.PNYX_ACTOR = 'web'

    if (memory) {
      ownerEnv.PNYX_MEMORY_ACCESS = memory
    }

    try {
      const { stdout } = await exec(
        process.execPath,
        [
          ...SOURCE_CONDITIONS,
          ENTRY,
          target.name,
          ...target.args,
          // Setup without a target runs every Hydra and refuses --hydra.
          ...(target.name === 'setup' && parseArgs({
            args: target.args,
            options: {
              ...WRITE,
              port: { type: 'string' },
            },
            strict: false,
            allowPositionals: true,
          }).positionals.length === 0 ? [] : [
              '--hydra',
              hydraId,
            ]),
        ],
        {
          cwd: target.cwd,
          env: ownerEnv,
          maxBuffer: 4 * 1024 * 1024,
        },
      )

      if (/^confirmation: needed$/m.test(stdout)) {
        throw new HydraError({
          message: 'The approved command still requires confirmation',
          code: 'CONFLICT',
        })
      }

      output = stdout.trim()
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      const detail = stdout.trim() || (error instanceof Error ? error.message : String(error))
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            meta: actor,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.dispatch-progress',
              data: {
                token,
                status: 'failed',
                error: detail,
              },
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })

      const code = /^code: (REVISION_CONFLICT|CONFLICT)$/m.exec(stdout)?.[1]

      if (memory && (code === 'CONFLICT' || code === 'REVISION_CONFLICT')) {
        throw new HydraError({
          message: 'Memory changed; propose the action again',
          code,
        })
      }

      throw error
    }

    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: actor,
          cardId: HYDRA_CARD,
          change: {
            type: 'hydra.dispatch-resolved',
            data: {
              token,
              action: 'confirmed',
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })

    return {
      proposal: token,
      state: 'confirmed',
      output,
    }
  },
})
