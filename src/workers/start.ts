import { inform } from '#app/command-notices.ts'
import { requireHandoffAvailable } from './handoff-checkout.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { copySettling, requireCopyAvailable } from '#projects/copy-lease.ts'
import { startBlockers } from '#tasks/dependencies.ts'
import { noteOnce } from '#tasks/notes.ts'
import type { Blocker } from '#tasks/owner-gates.ts'
import { dispatchTask, ruleCandidates, startCandidates, type DispatchChoice, type Override } from './dispatch.ts'
import { modelIds, type ModelOption } from './provider.ts'
import { effectiveDispatch } from './dispatch-config.ts'
import { randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { checkRevision, findCard } from '#tasks/push-rules.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { taskFolder } from '#projects/copy-create.ts'
import type { Harness } from '#workers/providers.ts'
import { canonical } from '#store/paths.ts'
import { askHost } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { taskPrompt } from './worker-brief.ts'
import { namedProjectCommand, startCommand } from './start-command.ts'
import { decideQueue } from './queue-decisions.ts'
import { sendReply } from './reply.ts'
import { flagGiven } from './cli.ts'

const VIAS = [
  'pnyx',
  'command',
] as const
type Via = (typeof VIAS)[number]

export function startRoute({
  via,
  commandName,
  replacement,
  override,
  tools,
}: {
  via?: string
  commandName?: string
  replacement?: string
  override?: Override
  tools?: string[]
}): Via {
  const chosen = via ?? 'pnyx'

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new HydraError({
      message: `unknown start route: ${chosen}`,
      code: 'VALIDATION_ERROR',
      help: [`Use --via ${VIAS.join('|')}`],
    })
  }

  const how = chosen as Via

  if (commandName && how !== 'command') {
    throw new HydraError({
      message: '--command needs --via command',
      code: 'VALIDATION_ERROR',
    })
  }

  if (replacement && how !== 'pnyx') {
    throw new HydraError({
      message: 'starting fresh from an outside session uses Pnyx',
      code: 'VALIDATION_ERROR',
    })
  }

  if (override && how === 'command') {
    throw new HydraError({
      message: '--account, --model, --effort, --mode and --fast apply to an agent Pnyx starts',
      code: 'VALIDATION_ERROR',
      help: ['Use --via pnyx'],
    })
  }

  if (tools?.length && how !== 'pnyx') {
    throw new HydraError({
      message: 'Tool grants require the pnyx launch route',
      code: 'VALIDATION_ERROR',
    })
  }

  return how
}

export function startRecorded({
  state,
  id,
}: {
  state: HydraState
  id: string
}): boolean {
  return [
    `${id}:attach`,
    `${id}:started`,
  ].some(recorded => Object.hasOwn(
    state.eventIds,
    recorded,
  ))
}

function queuedRefusal({
  task,
  session,
}: {
  task: string
  session: string
}) {
  return new HydraError({
    message: `task ${task} is queued behind worker ${session}`,
    code: 'CONFLICT',
    help: [`Run \`pnyx task unqueue ${task}\` first to give it its own worker`],
  })
}

function requireLiveTask({
  card,
  ref,
}: {
  card: Card
  ref: string
}): void {
  if (card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx task list`'],
    })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Worker action requested on a hidden task',
      clear: `Use pnyx task unhide ${card.id} to show it in Hydra`,
    })
  }
}

export function freeTask({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card {
  const card = findCard({
    state,
    ref,
  })

  requireLiveTask({
    card,
    ref,
  })

  if (card.queue) {
    throw queuedRefusal({
      task: card.id,
      session: card.queue.session,
    })
  }

  if (card.sessionIds?.length) {
    throw new HydraError({
      message: `task ${card.id} already has an attached agent: ${card.sessionIds.join(', ')}`,
      code: 'SESSION_CONFLICT',
      help: [`Run \`pnyx task detach ${card.id}\` to free it, or reply to that worker with \`pnyx reply ${card.id} --text "<message>"\``],
    })
  }

  return card
}

// The harness catalogs the Hydra's server reads; one it cannot read is left out, so its models are not checked.
async function hostedOffers({
  hydraId,
  harnesses,
}: {
  hydraId: string
  harnesses: Harness[]
}): Promise<Partial<Record<Harness, string[]>>> {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(async harness => {
    try {
      const { models } = await askHost({
        hydraId,
        body: {
          action: 'models',
          harness,
        },
      }) as { models: ModelOption[] }
      offers[harness] = modelIds({ models })
    } catch (error) {
      if (error instanceof HydraError && error.code === 'NOT_RUNNING') {
        throw error
      }
    }
  }))

  return offers
}

const START_FLAG_NAMES = {
  via: '--via',
  rule: '--rule',
  harness: '--harness',
  override: '--account, --model, --effort, --mode or --fast',
  tools: '--tool',
  folder: '--folder',
  inPlace: '--in-place',
  commandName: '--command',
}

type StartFlag = keyof typeof START_FLAG_NAMES

function unappliedFlags({ given }: { given: Record<StartFlag, unknown> }): string[] {
  return Object.entries(START_FLAG_NAMES)
    .filter(([name]) => flagGiven({ value: given[name as StartFlag] }))
    .map(([
      , flag,
    ]) => flag)
}

async function steerAttached({
  hydraId,
  card,
  worker,
  prompt,
  unapplied,
  meta,
}: {
  hydraId: string
  card: Card
  worker: string
  prompt?: string
  unapplied: string[]
  meta: Meta
}): Promise<Output> {
  const receipt = {
    task: card.id,
    worker,
    ...(unapplied.length ? {
      unapplied,
      reason: `worker ${worker} is already attached, so its start flags were not applied`,
    } : {}),
  }
  const help = [
    `Reply to it with \`pnyx reply ${card.id} --text "<message>"\``,
    `Run \`pnyx task detach ${card.id}\` first to start a new worker instead`,
  ]

  if (!prompt) {
    return {
      ...receipt,
      launch: 'running',
      help,
    }
  }

  try {
    const sent = await sendReply({
      hydraId,
      request: {
        card: card.id,
        expectedSession: worker,
        text: prompt,
        actor: meta.actor,
        reason: meta.reason,
        id: meta.id ? `${meta.id}:steer` : randomUUID(),
      },
    })

    return {
      ...receipt,
      launch: 'steered',
      delivery: sent.state,
      help,
    }
  } catch (error) {
    if (!(error instanceof HydraError) || error.code !== 'NO_ROUTE') {
      throw error
    }

    return {
      ...receipt,
      launch: 'running',
      delivery: 'not sent',
      blocker: error.message,
      help: [
        ...error.help,
        ...help,
      ],
    }
  }
}

function leaseOrWait({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): { release: () => void } | { waiting: Output } {
  try {
    return {
      release: taskLease({
        hydraId,
        task,
        actor: 'main',
      }),
    }
  } catch (error) {
    const otherTurn = error instanceof HydraError && error.code === 'TASK_LEASED' && !copySettling({
      hydraId,
      task,
    })

    if (!otherTurn) {
      throw error
    }

    return {
      waiting: {
        task,
        launch: 'waiting',
        blocker: error.message,
        help: error.help,
      },
    }
  }
}

function leaveQueue({
  hydraId,
  card,
  meta,
}: {
  hydraId: string
  card: Card
  meta: Meta
}): string | undefined {
  const session = withWriter({
    hydraId,
    fn: ({ writer }) => {
      const queued = writer.state.cards[card.id]?.queue?.session

      if (!queued) {
        return undefined
      }

      applyDecision({
        writer,
        decision: decideQueue({
          state: writer.state,
          task: card.id,
          meta: {
            ...meta,
            id: meta.id ? `${meta.id}:unqueue` : undefined,
            ifRevision: undefined,
          },
        }),
      })

      return queued
    },
  })

  return session && `was queued behind worker ${session}; it now gets its own worker`
}

function noteOpen({
  hydraId,
  task,
  open,
  meta,
}: {
  hydraId: string
  task: string
  open: Blocker[]
  meta: Meta
}): void {
  if (!open.length) {
    return
  }

  noteOnce({
    hydraId,
    task,
    source: 'pnyx:start',
    text: [
      'Started with these still open:',
      ...open.map(item => `- ${item.reason}. ${item.clear}`),
    ].join('\n'),
    meta,
  })
}

export async function startTask({
  hydraId,
  task,
  via,
  rule,
  harness,
  override,
  tools,
  prompt,
  folder: given,
  inPlace,
  replacement,
  inputId,
  commandName,
  meta,
}: {
  hydraId: string
  task: string
  replacement?: string
  inputId?: string
  commandName?: string
  via?: string
  rule?: string
  harness?: string
  override?: Override
  tools?: string[]
  prompt?: string
  folder?: string
  inPlace?: boolean
  meta: Meta
}): Promise<Output> {
  const how = startRoute({
    via,
    commandName,
    replacement,
    override,
    tools,
  })
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: task,
  })

  requireHandoffAvailable({
    hydraId,
    task: card.id,
  })

  requireCopyAvailable({
    hydraId,
    task: card.id,
  })

  if (meta.id && startRecorded({
    state,
    id: meta.id,
  })) {
    return {
      task: card.id,
      event: 'none: duplicate',
      help: ['This start was already recorded; nothing was started again'],
    }
  }

  const worker = card.sessionIds?.[0]

  if (worker && !replacement) {
    requireLiveTask({
      card,
      ref: task,
    })
    checkRevision({
      card,
      ifRevision: meta.ifRevision,
    })

    return steerAttached({
      hydraId,
      card,
      worker,
      prompt,
      unapplied: unappliedFlags({
        given: {
          via,
          rule,
          harness,
          override,
          tools,
          folder: given,
          inPlace,
          commandName,
        },
      }),
      meta,
    })
  }

  const leased = leaseOrWait({
    hydraId,
    task: card.id,
  })

  if ('waiting' in leased) {
    return leased.waiting
  }

  const release = leased.release

  try {
    const guided = ({
      started,
      unqueued,
    }: {
      started: Output
      unqueued?: string
    }): Output => {
      const current = loadHydra({ hydraId }).state
      const open = startBlockers({
        state: current,
        card: findCard({
          state: current,
          ref: card.id,
        }),
      })

      noteOpen({
        hydraId,
        task: card.id,
        open,
        meta,
      })

      return {
        ...started,
        ...(open.length ? { open } : {}),
        ...(unqueued ? { unqueued } : {}),
      }
    }

    checkRevision({
      card,
      ifRevision: meta.ifRevision,
    })

    let dispatch: DispatchChoice | undefined

    if (how !== 'command') {
      const { dispatch: effective } = effectiveDispatch()
      const list = harness ? startCandidates({
        dispatch: effective,
        rule,
        harness,
        override,
      }) ?? []
        : override?.model ? ([
          'claude',
          'codex',
        ] as const).map(harness => ({
          harness,
          model: override.model,
        }))
          : ruleCandidates({
            dispatch: effective,
            rule,
          }) ?? []

      const named = list.filter(c => (!harness || c.harness === harness)
        && (override?.model || c.model))
      const offers = await hostedOffers({
        hydraId,
        harnesses: named.map(c => c.harness),
      })

      dispatch = await dispatchTask({
        project: card.project,
        rule,
        harness,
        override,
        offers,
      })
    }

    const agent = dispatch?.candidate

    const command = how === 'command' || !agent
    const selectedCommand = commandName
      ? namedProjectCommand({
        state,
        card,
        name: commandName,
      }) : undefined
    const ownsFolder = commandName
      ? selectedCommand?.bringsOwnFolder : Boolean(state.config?.commandOwnsFolder)
    const ownFolder = command && ownsFolder
    const unqueued = leaveQueue({
      hydraId,
      card,
      meta,
    })

    const folder = replacement ? given
      : await taskFolder({
        hydraId,
        task,
        folder: given,
        inPlace,
        ownFolder,
        meta,
      })

    if (command) {
      return guided({
        started: await startCommand({
          hydraId,
          role: 'worker',
          task,
          prompt,
          folder,
          harness,
          commandName,
          meta,
        }),
        unqueued,
      })
    }

    const started = await askHost({
      hydraId,
      body: {
        action: 'start',
        inputId,
        dispatch,
        tools,
        task: card.id,
        ...(replacement ? { replacement } : {}),
        prompt: await taskPrompt({
          hydraId,
          card,
          prompt,
          replacing: replacement,
        }),
        ...(canonical({ path: folder }) ? { folder: canonical({ path: folder }) } : {}),
        id: meta.id ?? randomUUID(),
        actor: meta.actor,
        ...(meta.reason ? { reason: meta.reason } : {}),
      },
    }) as Output

    return guided({
      started: {
        ...started,
        rule: dispatch?.rule,
      },
      unqueued,
    })
  } catch (error) {
    if (error instanceof HydraError && error.code === 'TASK_STARTING') {
      return {
        task: card.id,
        launch: 'pending',
        blocker: error.message,
        help: error.help,
      }
    }

    throw error
  } finally {
    release()
  }
}
