import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { HydraError } from '#store/errors.ts'
import { decideDependencies, prerequisiteCards } from '#tasks/dependency-decisions.ts'
import type { Card } from '#tasks/model.ts'
import { decideNote, noteId } from '#tasks/notes.ts'
import { goQuestionCommand } from '#tasks/owner-gates.ts'
import { localTaskCommand } from '#tasks/plans-cli.ts'
import { findCard } from '#tasks/push-rules.ts'
import { flagGiven, START_FLAGS, startFlags } from './cli.ts'
import { decideQueue, queueAnchor, queueGap } from './queue-decisions.ts'
import { findSession } from './session-attachments.ts'
import { startRecorded, startRoute, startTask } from './start.ts'

const WAIT_FLAGS = {
  hold: 'hold',
  queue: 'behind',
  depend: 'on',
  unstarted: 'no-start',
}

type Values = Record<string, string | boolean | string[] | undefined>
type Wait = keyof typeof WAIT_FLAGS

function chooseWait({ values }: { values: Values }): Wait | undefined {
  const given = (Object.keys(WAIT_FLAGS) as Wait[])
    .filter(wait => flagGiven({ value: values[WAIT_FLAGS[wait]] }))

  if (given.length > 1) {
    throw new HydraError({
      message: 'choose one of --hold, --behind, --on or --no-start',
      code: 'VALIDATION_ERROR',
    })
  }

  const wait = given[0]
  const startFlag = START_FLAGS.find(name => values[name] !== undefined)

  if (wait && startFlag) {
    throw new HydraError({
      message: `--${startFlag} applies only when create starts a worker, and --${WAIT_FLAGS[wait]} leaves it unstarted`,
      code: 'VALIDATION_ERROR',
    })
  }

  return wait
}

function requireWaitTargets({
  state,
  wait,
  values,
  meta,
}: {
  state: HydraState
  wait?: Wait
  values: Values
  meta: Meta
}): void {
  if (wait === 'depend') {
    prerequisiteCards({
      state,
      prerequisites: values.on as string[],
      meta,
    })
  }

  if (wait !== 'queue') {
    return
  }

  const behind = values.behind as string

  if (!queueAnchor({
    state,
    behind,
  })) {
    findSession({
      state,
      ref: behind,
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
  unstarted: ({ card }) => ({
    launch: 'not started',
    reason: card.unstarted ?? 'no reason given',
    help: [`Run \`pnyx-axi task start ${card.id}\` to start a worker`],
  }),
}

function recordedLaunch({
  state,
  id,
}: {
  state: HydraState
  id: string
}): 'started' | 'requested' | undefined {
  if (startRecorded({
    state,
    id,
  })) {
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

function recordWait({
  hydraId,
  task,
  wait,
  values,
  meta,
  operation,
}: {
  hydraId: string
  task: string
  wait: Wait
  values: Values
  meta: Meta
  operation: string
}): void {
  const decide = ({ state }: { state: HydraState }) => {
    if (wait === 'queue') {
      return decideQueue({
        state,
        task,
        behind: values.behind as string,
        meta: {
          ...meta,
          id: `${operation}:queue`,
          ifRevision: undefined,
        },
      })
    }

    return decideDependencies({
      state,
      ref: task,
      prerequisites: values.on as string[],
      remove: false,
      meta: {
        ...meta,
        id: `${operation}:depend`,
        ifRevision: undefined,
      },
    })
  }

  withWriter({
    hydraId,
    fn: ({ writer }) => applyDecision({
      writer,
      decision: decide({ state: writer.state }),
    }),
  })
}

function noteBlocker({
  hydraId,
  task,
  error,
  meta,
  operation,
}: {
  hydraId: string
  task: string
  error: HydraError
  meta: Meta
  operation: string
}): void {
  const text = [
    `Could not start a worker: ${error.message}`,
    ...error.help,
  ].join('\n')

  withWriter({
    hydraId,
    fn: ({ writer }) => applyDecision({
      writer,
      decision: decideNote({
        state: writer.state,
        ref: task,
        note: {
          kind: 'context',
          source: 'pnyx:create',
          text,
        },
        meta: {
          ...meta,
          id: noteId({
            cardKey: operation,
            ref: text,
          }),
          ifRevision: undefined,
        },
      }),
    }),
  })
}

async function startCreated({
  hydraId,
  task,
  flags,
  meta,
  operation,
}: {
  hydraId: string
  task: string
  flags: ReturnType<typeof startFlags>
  meta: Meta
  operation: string
}): Promise<Output> {
  const startId = `${operation}:start`
  const resend = `Run \`pnyx-axi task start ${task} --event-id ${startId}\` if Firstmate did not get the request; the same id never asks twice`
  const state = loadHydra({ hydraId }).state
  const launched = recordedLaunch({
    state,
    id: startId,
  })

  if (launched === 'requested') {
    return {
      launch: 'requested',
      message: startId,
      help: [
        'This create already asked Firstmate for its worker; nothing was asked again',
        resend,
      ],
    }
  }

  if (launched === 'started') {
    return {
      launch: 'started',
      worker: state.cards[task]?.sessionIds?.[0] ?? 'none',
      help: ['This create already started its worker; nothing started again'],
    }
  }

  try {
    const started = await startTask({
      hydraId,
      task,
      ...flags,
      meta: {
        ...meta,
        id: startId,
        ifRevision: undefined,
      },
    })

    if (started.via === 'firstmate') {
      return {
        launch: 'requested',
        ...started,
        help: started.sent === 'failed' ? [resend] : started.help,
      }
    }

    return {
      launch: 'started',
      worker: loadHydra({ hydraId }).state.cards[task]?.sessionIds?.[0] ?? 'none',
      ...started,
    }
  } catch (error) {
    if (!(error instanceof HydraError)) {
      throw error
    }

    noteBlocker({
      hydraId,
      task,
      error,
      meta,
      operation,
    })

    return {
      launch: 'not started',
      code: error.code,
      blocker: error.message,
      help: [
        ...error.help,
        `Run \`pnyx-axi task start ${task}\` once it clears`,
      ],
    }
  }
}

export async function createCommand({
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
  const state = loadHydra({ hydraId }).state
  const chosen = chooseWait({ values })
  const flags = startFlags({ values })
  startRoute({
    state,
    via: flags.via,
    commandName: flags.commandName,
    override: flags.override,
    tools: flags.tools,
  })
  requireWaitTargets({
    state,
    wait: chosen,
    values,
    meta,
  })

  const created = (await localTaskCommand({
    action: 'create',
    values: values as Record<string, string | boolean | undefined>,
    positionals,
    hydraId,
    meta,
  }))!
  const task = (created.card as { id: string }).id
  const operation = meta.id ?? task
  const filed = loadHydra({ hydraId }).state
  const queuedBefore = Object.hasOwn(
    filed.eventIds,
    `${operation}:queue`,
  )
  const notQueued = chosen === 'queue' && !queuedBefore ? queueGap({
    state: filed,
    task,
    behind: values.behind as string,
  }) : undefined
  const wait = notQueued ? undefined : chosen

  if (wait === 'queue' || wait === 'depend') {
    recordWait({
      hydraId,
      task,
      wait,
      values,
      meta,
      operation,
    })
  }

  const receipt = wait
    ? WAIT_RECEIPTS[wait]({
      card: findCard({
        state: loadHydra({ hydraId }).state,
        ref: task,
      }),
    })
    : await startCreated({
      hydraId,
      task,
      flags,
      meta,
      operation,
    })

  if (!notQueued) {
    return {
      ...created,
      ...receipt,
    }
  }

  return {
    ...created,
    ...receipt,
    queued: `no: ${notQueued.reason}`,
    help: [
      ...receipt.help as string[],
      notQueued.clear,
    ],
  }
}
