import { ownerActor } from './actors.ts'
import { inform } from './command-notices.ts'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { join } from 'node:path'
import { WRITE, guard, meta, parse, required } from './cli-support.ts'
import { effectiveDispatch, type EffectiveDispatch } from '#workers/dispatch-config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { withWriter } from './writer.ts'
import { loadHydra } from './store.ts'
import { pnyxHome } from '#store/storage.ts'
import { SOURCE_CONDITIONS } from './source-conditions.ts'
import { requestEnv, IDENTITY, agentRequest } from '#app/request-context.ts'

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
  removalWork?: Record<string, string>
}

// Read before taking a Hydra writer, so the shared registry lock is never taken inside one.
const dispatchFor = ({ target }: { target: Target }) => target.name === 'rule' || target.name === 'account'
  ? effectiveDispatch()
  : undefined

function context({
  state,
  target,
  dispatch,
  removalSeq,
}: {
  state: HydraState
  target: Target
  dispatch?: EffectiveDispatch
  removalSeq?: number
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
  const removalId = name === 'hydra' && args[0] === 'remove' ? args[1] : undefined
  const removal = removalId ? removalSeq ?? loadHydra({ hydraId: removalId }).state.seq : undefined

  return createHash('sha256').update(JSON.stringify({
    config: name === 'hydra' || name === 'setup' ? state.config : undefined,
    projects: name === 'project' || name === 'owner' ? state.projects : undefined,
    dispatch,
    removal,
    card: card && {
      agent: card.agent,
      settings: card.settings,
      copy: card.copy,
      permissions: card.permissions,
    },
  }))
    .digest('hex')
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
    const actor = {
      ...meta({ values }),
      id: undefined,
    }

    if (actor.actor === 'hydra' || agentRequest()) {
      inform({
        reason: 'Approval question answered by an agent',
        clear: 'Use pnyx-axi approval dismiss <token> to dismiss a pending approval',
      })
    }

    const action = positionals[0]
    const token = required({
      value: positionals[1],
      what: 'proposal token',
    })

    if (action !== 'confirm' && action !== 'dismiss') {
      throw new HydraError({
        message: 'Use approval confirm|dismiss <token>',
        code: 'VALIDATION_ERROR',
      })
    }

    const asked = loadHydra({ hydraId }).state.dispatchProposals?.find(p => p.token === token)
    const confirming = action === 'confirm' && asked?.kind === 'command'
      ? JSON.parse(asked.value) as Target : undefined
    const dispatch = confirming ? dispatchFor({ target: confirming }) : undefined
    const selected = await withWriter({
      hydraId,
      fn: ({ writer }) => {
        const proposal = writer.state.dispatchProposals?.find(p => p.token === token)

        if (!proposal || proposal.kind !== 'command') {
          return undefined
        }

        if (proposal.status === 'applying') {
          throw new HydraError({
            message: 'This approved action is already applying; it cannot be confirmed or dismissed',
            code: 'CONFLICT',
          })
        }

        if (action === 'confirm' && proposal.status === 'failed') {
          inform({
            reason: 'Retrying a failed approved action after checking its target',
            clear: 'Use pnyx-axi approval dismiss <token> to dismiss it instead',
          })
        }

        if (action === 'confirm' && context({
          state: writer.state,
          target: JSON.parse(proposal.value) as Target,
          dispatch,
        }) !== proposal.before) {
          inform({
            reason: 'Applying a saved action after its target changed',
            clear: `Use pnyx-axi ${confirming?.name ?? 'task'} --help to inspect its current commands`,
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

    const target = JSON.parse(selected.value) as Target
    let output: string
    const ownerEnv = { ...process.env }

    for (const name of IDENTITY) {
      delete ownerEnv[name]
    }

    ownerEnv.PNYX_HOME = pnyxHome()
    const caller = requestEnv()
    const fromAgent = !ownerActor({ actor: actor.actor }) || agentRequest()

    if (fromAgent) {
      for (const name of IDENTITY) {
        if (caller[name] !== undefined) {
          ownerEnv[name] = caller[name]
        }
      }
    }

    ownerEnv.PNYX_ACTOR = fromAgent ? caller.PNYX_ACTOR ?? actor.actor : 'web'

    const removesHydra = target.name === 'hydra' && target.args[0] === 'remove'

    if (removesHydra) {
      target.args.push(
        '--confirm',
        token,
      )
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

      output = stdout.trim()
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      const commandOutput = stdout.trim()
      const detail = commandOutput.length > 0
        ? commandOutput
        : error instanceof Error ? error.message : String(error)
      await withWriter({
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

      const code = /^code: ([A-Z_]+)$/m.exec(stdout)?.[1]

      if (removesHydra || code) {
        if (error instanceof HydraError) {
          throw error
        }

        throw new HydraError({
          message: detail,
          code: code ?? 'UNKNOWN',
        })
      }

      throw error
    }

    await withWriter({
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

export async function recoverOwnerCommands({ hydraId }: { hydraId: string }): Promise<void> {
  const { state } = loadHydra({ hydraId })
  const interrupted = state.dispatchProposals?.filter(proposal =>
    proposal.kind === 'command' && proposal.status === 'applying') ?? []

  if (!interrupted.length || state.config?.removed || state.config?.removing) {
    return
  }

  await withWriter({
    hydraId,
    fn: ({ writer }) => {
      for (const proposal of interrupted) {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
          cardId: HYDRA_CARD,
          change: {
            type: 'hydra.dispatch-progress',
            data: {
              token: proposal.token,
              status: 'failed',
              error: 'The server stopped before recording the result. Check whether the action completed before trying again.',
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      }
    },
  })
}
