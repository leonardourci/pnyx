import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { join } from 'node:path'
import { WRITE, guard, meta, parse, required, type Output } from './cli-support.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { withWriter } from './writer.ts'
import { pnyxHome } from '#store/storage.ts'
import { SOURCE_CONDITIONS } from './source-conditions.ts'

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

function context({
  state,
  target,
}: {
  state: HydraState
  target: Target
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
    config: name === 'hydra' || name === 'setup' ? state.config : undefined,
    projects: name === 'project' ? state.projects : undefined,
    dispatch: name === 'rule' || name === 'account' ? effectiveDispatch() : undefined,
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
    cwd: process.cwd(),
  }
  const value = JSON.stringify(target)
  const summary = `Approve pnyx-axi ${name} ${safe.map(arg => JSON.stringify(arg)).join(' ')}`
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

    if (actor.actor === 'hydra' || process.env.PNYX_ACTOR === 'hydra') {
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

    try {
      const { stdout } = await exec(
        process.execPath,
        [
          ...SOURCE_CONDITIONS,
          ENTRY,
          target.name,
          ...target.args,
          // setup service runs every Hydra and refuses --hydra.
          ...(target.name === 'setup' && parseArgs({
            args: target.args,
            options: {
              ...WRITE,
              port: { type: 'string' },
            },
            strict: false,
            allowPositionals: true,
          }).positionals[0] === 'service' ? [] : [
              '--hydra',
              hydraId,
            ]),
        ],
        {
          cwd: target.cwd,
          env: {
            ...process.env,
            PNYX_HOME: pnyxHome(),
            PNYX_ACTOR: 'web',
          },
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
      const detail = error instanceof Error ? error.message : String(error)
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
