import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { explained, required, type Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { HydraError } from '#store/errors.ts'
import { decideDependencies } from '#tasks/dependency-decisions.ts'
import { decideHold } from '#tasks/holds.ts'
import type { Card } from '#tasks/model.ts'
import { decideNote, noteId } from '#tasks/notes.ts'
import { goQuestionCommand } from '#tasks/owner-gates.ts'
import { planTaskChange, type TaskOperation } from '#tasks/plans.ts'
import { findCard } from '#tasks/push-rules.ts'
import { START_FLAGS, startFlags } from './cli.ts'
import { decideQueue } from './queue-decisions.ts'
import { sendReply } from './reply.ts'
import { startTask } from './start.ts'

const TASK_FLAGS = [
  'title',
  'project',
  'intent',
  'kind',
  'parent',
]
const INTAKE_FLAGS = [
  'hydra',
  'actor',
  'reason',
  'details',
  'event-id',
  'ask',
  'message',
  'brief',
  'folder',
  'behind',
  'on',
  'hold',
  ...START_FLAGS,
]
const NO_LANDING = new Map<string, string[]>()
const WAIT_NOUNS = {
  hold: 'hold',
  queue: 'queue',
  depend: 'dependency',
}

type Values = Record<string, string | boolean | string[] | undefined>
type Wait = keyof typeof WAIT_NOUNS
type Disposition = 'start' | Wait

function requireIntakeFlags({
  values,
  reuse,
}: {
  values: Values
  reuse: boolean
}): void {
  const allowed = [...INTAKE_FLAGS]

  if (!reuse) {
    allowed.push(...TASK_FLAGS)
  }

  const given = Object.keys(values).filter(name => values[name] !== undefined)
  const extra = given.find(name => !allowed.includes(name))

  if (extra) {
    throw new HydraError({
      message: `unknown flag --${extra} for task intake${reuse ? ' on an existing task' : ''}`,
      code: 'VALIDATION_ERROR',
      help: [`Valid flags: ${allowed.map(name => `--${name}`).join(', ')}`],
    })
  }
}

function chooseDisposition({
  values,
  reuse,
}: {
  values: Values
  reuse: boolean
}): Disposition {
  const waits: Wait[] = []

  if (values.hold) {
    waits.push('hold')
  }

  if (values.behind !== undefined) {
    waits.push('queue')
  }

  if (Array.isArray(values.on) && values.on.length) {
    waits.push('depend')
  }

  if (waits.length > 1) {
    throw new HydraError({
      message: 'choose one of --hold, --behind or --on',
      code: 'VALIDATION_ERROR',
    })
  }

  const wait = waits[0]
  const startOnly = reuse ? [
    ...START_FLAGS,
    'folder',
  ] : START_FLAGS
  const startFlag = startOnly.find(name => values[name] !== undefined)

  if (wait && startFlag) {
    throw new HydraError({
      message: `--${startFlag} only applies when intake starts a worker; this intake records a ${WAIT_NOUNS[wait]}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return wait ?? 'start'
}

function recordTask({
  writer,
  hydraId,
  ref,
  ask,
  values,
  hold,
  meta,
  operation,
}: {
  writer: Writer
  hydraId: string
  ref?: string
  ask: string
  values: Values
  hold: boolean
  meta: Meta
  operation: string
}): Card {
  const plan = ({
    change,
    id,
  }: {
    change: TaskOperation
    id: string
  }) => planTaskChange({
    state: writer.state,
    operation: change,
    meta: {
      ...meta,
      id,
    },
    hydraId,
    landing: NO_LANDING,
  })
  const message = values.message as string | undefined
  const brief = values.brief as string | undefined

  if (!ref) {
    const key = `task:${operation}`
    const filed = Object.hasOwn(
      writer.state.eventIds,
      operation,
    )

    if (!filed) {
      applyDecision({
        writer,
        decision: plan({
          id: operation,
          change: {
            op: 'task.create',
            key,
            title: required({
              value: values.title as string | undefined,
              what: '--title <title> (or name an existing task)',
            }),
            project: values.project as string | undefined,
            intent: values.intent as string | undefined,
            kind: values.kind as string | undefined,
            parent: values.parent as string | undefined,
            folder: values.folder as string | undefined,
            brief: required({
              value: brief,
              what: '--brief <instructions for the worker>',
            }),
            ask,
            message,
            hold,
          },
        }),
      })
    }

    return findCard({
      state: writer.state,
      ref: key,
    })
  }

  const card = findCard({
    state: writer.state,
    ref,
  })
  applyDecision({
    writer,
    decision: plan({
      id: `${operation}:ask`,
      change: {
        op: 'task.owner-ask',
        task: card.id,
        text: ask,
        message,
      },
    }),
  })

  if (brief !== undefined) {
    applyDecision({
      writer,
      decision: plan({
        id: `${operation}:brief`,
        change: {
          op: 'task.brief',
          task: card.id,
          brief,
        },
      }),
    })
  }

  if (hold) {
    applyDecision({
      writer,
      decision: decideHold({
        state: writer.state,
        ref: card.id,
        release: false,
        meta: {
          ...meta,
          id: `${operation}:hold`,
        },
      }),
    })
  }

  return findCard({
    state: writer.state,
    ref: card.id,
  })
}

function recordWait({
  writer,
  card,
  disposition,
  values,
  meta,
  operation,
}: {
  writer: Writer
  card: Card
  disposition: Disposition
  values: Values
  meta: Meta
  operation: string
}): void {
  if (disposition === 'queue') {
    applyDecision({
      writer,
      decision: decideQueue({
        state: writer.state,
        task: card.id,
        behind: values.behind as string,
        meta: {
          ...meta,
          id: `${operation}:queue`,
        },
      }),
    })
  }

  if (disposition === 'depend') {
    applyDecision({
      writer,
      decision: decideDependencies({
        state: writer.state,
        ref: card.id,
        prerequisites: values.on as string[],
        remove: false,
        meta: {
          ...meta,
          id: `${operation}:depend`,
        },
      }),
    })
  }
}

const WAIT_RECEIPTS: Record<Wait, ({ card }: { card: Card }) => Output> = {
  hold: ({ card }) => ({
    launch: 'held',
    hold: card.hold?.reason ?? 'released',
    help: [`Ask the go question when ready: \`${goQuestionCommand({ task: card.id })}\``],
  }),
  queue: ({ card }) => ({
    launch: 'queued',
    behind: card.queue?.session ?? 'none',
    help: ['Pnyx hands it to that worker once its current work lands'],
  }),
  depend: ({ card }) => ({
    launch: 'waiting',
    on: card.prerequisites ?? [],
    help: [`Start it with \`pnyx-axi task start ${card.id}\` once its prerequisites are done`],
  }),
}

function recordedLaunch({
  state,
  id,
}: {
  state: HydraState
  id: string
}): 'started' | 'requested' | undefined {
  const attached = [
    `${id}:attach`,
    `${id}:started`,
  ].some(recorded => Object.hasOwn(
    state.eventIds,
    recorded,
  ))

  if (attached) {
    return 'started'
  }

  if (Object.hasOwn(
    state.eventIds,
    id,
  )) {
    return 'requested'
  }

  return undefined
}

function noteBlocker({
  hydraId,
  card,
  error,
  meta,
  operation,
}: {
  hydraId: string
  card: Card
  error: HydraError
  meta: Meta
  operation: string
}): void {
  const text = [
    `Intake could not start a worker: ${error.message}`,
    ...error.help,
  ].join('\n')

  withWriter({
    hydraId,
    fn: ({ writer }) => applyDecision({
      writer,
      decision: decideNote({
        state: writer.state,
        ref: card.id,
        note: {
          kind: 'context',
          source: 'pnyx:intake',
          text,
        },
        meta: {
          ...meta,
          id: noteId({
            cardKey: operation,
            ref: text,
          }),
        },
      }),
    }),
  })
}

async function steerWorker({
  hydraId,
  card,
  worker,
  ask,
  values,
  meta,
  id,
}: {
  hydraId: string
  card: Card
  worker: string
  ask: string
  values: Values
  meta: Meta
  id: string
}): Promise<Output> {
  const brief = values.brief as string | undefined
  const parts = [`The owner asked: ${ask}`]

  if (brief !== undefined) {
    parts.push(`Updated instructions:\n${brief}`)
  }

  const home = loadHydra({ hydraId }).state.config?.hydra.home
  const sent = await sendReply({
    hydraId,
    request: {
      card: card.id,
      text: parts.join('\n\n'),
      homes: home ? [home] : [],
      actor: meta.actor,
      reason: meta.reason,
      id,
    },
  })

  return {
    task: card.id,
    launch: 'steered',
    worker,
    delivery: sent.state,
    help: [`Follow it with \`pnyx-axi task history ${card.id}\``],
  }
}

export async function intakeCommand({
  hydraId,
  positionals,
  values,
  meta,
}: {
  hydraId: string
  positionals: string[]
  values: Values
  meta: Meta
}): Promise<Output> {
  const ref = positionals[1]
  const reuse = ref !== undefined

  if (positionals.length > 2) {
    throw new HydraError({
      message: `unexpected argument: ${positionals[2]}`,
      code: 'VALIDATION_ERROR',
    })
  }

  requireIntakeFlags({
    values,
    reuse,
  })
  const operation = required({
    value: meta.id,
    what: '--event-id <stable id>, so a retry never starts a second worker',
  })
  explained({ meta })
  const ask = required({
    value: values.ask as string | undefined,
    what: '--ask <the owner\'s exact words>',
  })
  const disposition = chooseDisposition({
    values,
    reuse,
  })
  const start = startFlags({ values })
  const startId = `${operation}:start`
  const steerId = `${operation}:steer`

  const card = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const recorded = recordTask({
        writer,
        hydraId,
        ref,
        ask,
        values,
        hold: disposition === 'hold',
        meta,
        operation,
      })
      const attached = recorded.sessionIds?.[0]

      if (reuse && disposition !== 'start' && attached) {
        throw new HydraError({
          message: `task ${recorded.id} already has worker ${attached}; a ${WAIT_NOUNS[disposition]} applies only to work that has not started`,
          code: 'CONFLICT',
          help: ['Repeat without --hold, --behind or --on to send the ask to that worker'],
        })
      }

      recordWait({
        writer,
        card: recorded,
        disposition,
        values,
        meta,
        operation,
      })

      return findCard({
        state: writer.state,
        ref: recorded.id,
      })
    },
  })

  if (disposition !== 'start') {
    return {
      task: card.id,
      ...WAIT_RECEIPTS[disposition]({ card }),
    }
  }

  const resend = `Run \`pnyx-axi task start ${card.id} --event-id ${startId}\` if Firstmate did not get the request; the same id never asks twice`
  const launched = recordedLaunch({
    state: loadHydra({ hydraId }).state,
    id: startId,
  })

  if (launched === 'requested') {
    return {
      task: card.id,
      launch: 'requested',
      message: startId,
      help: [
        'This intake already asked Firstmate for its worker; nothing was asked again',
        resend,
      ],
    }
  }

  const worker = card.sessionIds?.[0]

  if (launched === 'started') {
    return {
      task: card.id,
      launch: 'started',
      worker: worker ?? 'none',
      help: ['This intake already started its worker; nothing started again'],
    }
  }

  const steered = card.replies?.some(reply => reply.id === steerId)

  if (worker || steered) {
    return steerWorker({
      hydraId,
      card,
      worker: worker ?? 'none',
      ask,
      values,
      meta,
      id: steerId,
    })
  }

  const retry = `Retry with --event-id ${operation} once it clears; the same id never starts a second worker`
  const startFolder = reuse ? values.folder as string : undefined

  try {
    const started = await startTask({
      hydraId,
      task: card.id,
      ...start,
      folder: startFolder,
      meta: {
        ...meta,
        id: startId,
      },
    })

    if (started.via === 'firstmate') {
      const help = started.sent === 'failed' ? [resend] : started.help

      return {
        task: card.id,
        launch: 'requested',
        ...started,
        help,
      }
    }

    return {
      task: card.id,
      launch: 'started',
      worker: loadHydra({ hydraId }).state.cards[card.id]?.sessionIds?.[0] ?? 'none',
      ...started,
    }
  } catch (error) {
    if (!(error instanceof HydraError)) {
      throw error
    }

    if (error.code === 'TASK_STARTING') {
      return {
        task: card.id,
        launch: 'pending',
        help: [
          ...error.help,
          retry,
        ],
      }
    }

    noteBlocker({
      hydraId,
      card,
      error,
      meta,
      operation,
    })

    return {
      task: card.id,
      launch: 'blocked',
      code: error.code,
      blocker: error.message,
      help: [
        ...error.help,
        retry,
      ],
    }
  }
}
