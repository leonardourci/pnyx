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
import type { TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { checkRevision, findCard } from '#tasks/push-rules.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { taskFolder } from '#projects/copy-create.ts'
import type { Harness } from '#workers/providers.ts'
import { canonical } from '#store/paths.ts'
import { askHost } from '#app/server-state.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { taskPrompt } from './worker-brief.ts'
import { namedProjectCommand, startCommand } from './start-command.ts'
import { decideQueue } from './queue-decisions.ts'
import { sendReply } from './reply.ts'
import { flagGiven } from './cli.ts'

const VIAS = [
  'othrys',
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
  const chosen = via ?? 'othrys'

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new TitanError({
      message: `unknown start route: ${chosen}`,
      code: 'VALIDATION_ERROR',
      help: [`Use --via ${VIAS.join('|')}`],
    })
  }

  const how = chosen as Via

  if (commandName && how !== 'command') {
    throw new TitanError({
      message: '--command needs --via command',
      code: 'VALIDATION_ERROR',
    })
  }

  if (replacement && how !== 'othrys') {
    throw new TitanError({
      message: 'starting fresh from an outside session uses Othrys',
      code: 'VALIDATION_ERROR',
    })
  }

  if (override && how === 'command') {
    throw new TitanError({
      message: '--account, --model, --effort, --mode and --fast apply to an agent Othrys starts',
      code: 'VALIDATION_ERROR',
      help: ['Use --via othrys'],
    })
  }

  if (tools?.length && how !== 'othrys') {
    throw new TitanError({
      message: 'Tool grants require the othrys launch route',
      code: 'VALIDATION_ERROR',
    })
  }

  return how
}

export function startRecorded({
  state,
  id,
}: {
  state: TitanState
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
  return new TitanError({
    message: `task ${task} is queued behind worker ${session}`,
    code: 'CONFLICT',
    help: [`Remove ${task} from the queue in the UI before giving it its own worker.`],
  })
}

function requireLiveTask({
  card,
  ref,
}: {
  card: Card
  ref: string
}): void {
  if (card.id === TITAN_CARD) {
    throw new TitanError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Use othrys board'],
    })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Worker action requested on a hidden task',
      clear: `Review the visibility of task ${card.id} in the UI.`,
    })
  }
}

export function freeTask({
  state,
  ref,
}: {
  state: TitanState
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
    throw new TitanError({
      message: `task ${card.id} already has an attached agent: ${card.sessionIds.join(', ')}`,
      code: 'SESSION_CONFLICT',
      help: [`Detach the worker in the UI or reply with \`othrys send --task ${card.id} --text "<message>"\``],
    })
  }

  return card
}

// The harness catalogs the Titan's server reads; one it cannot read is left out, so its models are not checked.
async function hostedOffers({
  titanId,
  harnesses,
}: {
  titanId: string
  harnesses: Harness[]
}): Promise<Partial<Record<Harness, string[]>>> {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(async harness => {
    try {
      const { models } = await askHost({
        titanId,
        body: {
          action: 'models',
          harness,
        },
      }) as { models: ModelOption[] }
      offers[harness] = modelIds({ models })
    } catch (error) {
      if (error instanceof TitanError && error.code === 'NOT_RUNNING') {
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
  titanId,
  card,
  worker,
  prompt,
  unapplied,
  meta,
}: {
  titanId: string
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
    `Reply with \`othrys send --task ${card.id} --text "<message>"\``,
    'Detach the worker in the UI before starting a new one',
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
      titanId,
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
    if (!(error instanceof TitanError) || error.code !== 'NO_ROUTE') {
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
  titanId,
  task,
}: {
  titanId: string
  task: string
}): { release: () => void } | { waiting: Output } {
  try {
    return {
      release: taskLease({
        titanId,
        task,
        actor: 'main',
      }),
    }
  } catch (error) {
    const otherTurn = error instanceof TitanError && error.code === 'TASK_LEASED' && !copySettling({
      titanId,
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

async function leaveQueue({
  titanId,
  card,
  meta,
}: {
  titanId: string
  card: Card
  meta: Meta
}): Promise<string | undefined> {
  const session = await withWriter({
    titanId,
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

async function noteOpen({
  titanId,
  task,
  open,
  meta,
}: {
  titanId: string
  task: string
  open: Blocker[]
  meta: Meta
}): Promise<void> {
  if (!open.length) {
    return
  }

  await noteOnce({
    titanId,
    task,
    source: 'othrys:start',
    text: [
      'Started with these still open:',
      ...open.map(item => `- ${item.reason}. ${item.clear}`),
    ].join('\n'),
    meta,
  })
}

export async function startTask({
  titanId,
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
  titanId: string
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
  const state = loadTitan({ titanId }).state
  const card = findCard({
    state,
    ref: task,
  })

  requireHandoffAvailable({
    titanId,
    task: card.id,
  })

  requireCopyAvailable({
    titanId,
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
      titanId,
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
    titanId,
    task: card.id,
  })

  if ('waiting' in leased) {
    return leased.waiting
  }

  const release = leased.release

  try {
    const guided = async ({
      started,
      unqueued,
    }: {
      started: Output
      unqueued?: string
    }): Promise<Output> => {
      const current = loadTitan({ titanId }).state
      const open = startBlockers({
        state: current,
        card: findCard({
          state: current,
          ref: card.id,
        }),
      })

      await noteOpen({
        titanId,
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
        titanId,
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
    const unqueued = await leaveQueue({
      titanId,
      card,
      meta,
    })

    const folder = replacement ? given
      : await taskFolder({
        titanId,
        task,
        folder: given,
        inPlace,
        ownFolder,
        meta,
      })

    if (command) {
      return await guided({
        started: await startCommand({
          titanId,
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
      titanId,
      body: {
        action: 'start',
        inputId,
        dispatch,
        tools,
        task: card.id,
        ...(replacement ? { replacement } : {}),
        prompt: await taskPrompt({
          titanId,
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

    return await guided({
      started: {
        ...started,
        rule: dispatch?.rule,
      },
      unqueued,
    })
  } catch (error) {
    if (error instanceof TitanError && error.code === 'TASK_STARTING') {
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
