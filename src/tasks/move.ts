import { randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { base } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { askHost } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { readEvents } from '#app/event-log.ts'
import { carryCursors, harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HydraError } from '#store/errors.ts'
import { projectsFor } from '#projects/read.ts'
import { matchesProject } from '#projects/identity.ts'
import { hydraIds } from '#app/home-migration.ts'
import { taskSessions } from '#workers/cli.ts'
import { workerQueue } from '#workers/queue.ts'
import { fallbackColumn } from './column-rules.ts'
import { cardFacts, placeCard } from './columns.ts'
import type { Column } from './columns-model.ts'
import type { Card } from './model.ts'
import { movedAway, type HydraMoveEvent } from './move-state.ts'
import { isManagedTask } from './select.ts'
import { agentActivity } from '#workers/activity.ts'
import { activeHelperBatches } from '#routine-helper/state.ts'

const LIVE_SOURCE_STATES = new Set([
  'registered',
  'running',
])

const refuse = ({
  message,
  help,
  code = 'CONFLICT',
}: {
  message: string
  help: string
  code?: string
}) => new HydraError({
  message,
  code,
  help: [help],
})

const missing = ({
  hydraId,
  ref,
}: {
  hydraId: string
  ref: string
}) => refuse({
  message: `card not found: ${ref}`,
  help: `Run \`pnyx-axi task list --hydra ${hydraId}\``,
  code: 'NOT_FOUND',
})

const rerunCommand = ({
  card,
  to,
  hydraId,
}: {
  card: Card
  to: string
  hydraId: string
}) => `pnyx-axi task move ${card.id} --to-hydra ${to} --hydra ${hydraId}`

// The target's column with the card's column id, else its title, else where the target's rules place it.
function targetColumn({
  source,
  target,
  card,
}: {
  source: HydraState
  target: HydraState
  card: Card
}): Column {
  const columns = hydraConfig({ state: target }).columns
  const title = hydraConfig({ state: source }).columns.find(c => c.id === card.column)?.title
  const byId = columns.find(c => c.id === card.column)
  const byTitle = columns.find(c => c.title === title)
  const byRule = placeCard({
    card: cardFacts({
      card,
      state: source,
    }),
    columns,
  })

  return byId?.id ?? byTitle?.id ?? byRule ?? fallbackColumn({ columns })
}

// Every reason a move would leave something broken, each with the command that clears it.
function refusal({
  hydraId,
  to,
  source,
  target,
  card,
}: {
  hydraId: string
  to: string
  source: HydraState
  target: HydraState
  card: Card
}): HydraError | undefined {
  const rerun = rerunCommand({
    card,
    to,
    hydraId,
  })
  const others = Object.values(source.cards).filter(c => c.id !== card.id)
  const session = card.sessionIds?.[0]

  if (isManagedTask({ card })) {
    return refuse({
      message: `${card.id} is not an explicit task`,
      help: 'Choose a task from `pnyx-axi task list`',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hydraConfig({ state: target }).hydra.kind === 'firstmate') {
    return refuse({
      message: `Hydra ${to} follows a Firstmate home, which owns its own tasks`,
      help: 'Run `pnyx-axi hydra list` and choose a Hydra that is not linked to Firstmate',
    })
  }

  if (card.mirror || card.sourceRefs.some(ref => ref.adapter === 'firstmate')) {
    return refuse({
      message: `${card.id} mirrors a Firstmate task, which Firstmate would recreate on Hydra ${hydraId}`,
      help: 'Move the work in Firstmate itself',
    })
  }

  if (card.project && !projectsFor({ state: target }).some(p => !p.detached && matchesProject({
    project: p,
    ref: card.project,
  }))) {
    return refuse({
      message: `Hydra ${to} has no project ${card.project} attached`,
      help: `Run \`pnyx-axi project add ${card.project} --hydra ${to}\`, then \`${rerun}\``,
      code: 'NOT_FOUND',
    })
  }

  if (target.cards[card.id] || target.keys[card.key]) {
    return refuse({
      message: `Hydra ${to} already has a task with id or key ${card.id}`,
      help: `Run \`pnyx-axi task show ${card.id} --hydra ${to}\``,
    })
  }

  if (agentActivity({
    card,
    cards: source.cards,
  }) === 'working') {
    return refuse({
      message: `${card.id}'s worker is mid-turn`,
      help: `Wait for the turn to end (\`pnyx-axi task show ${card.id} --hydra ${hydraId}\`), then run \`${rerun}\``,
    })
  }

  if (session && card.agent?.host !== 'pnyx') {
    return refuse({
      message: `${card.id}'s worker runs outside Pnyx, and its hooks would keep writing to Hydra ${hydraId}`,
      help: `Run \`pnyx-axi task detach ${card.id} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  if (activeHelperBatches({ state: source }).some(batch => batch.tasks.includes(card.id))) {
    return refuse({
      message: `the routine helper is handling ${card.id}`,
      help: `Wait for the helper's batch to end (\`pnyx-axi debug health --hydra ${hydraId}\`), then run \`${rerun}\``,
    })
  }

  if (card.queue) {
    return refuse({
      message: `${card.id} is queued behind ${card.queue.session}`,
      help: `Run \`pnyx-axi task unqueue ${card.id} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  const behind = session ? workerQueue({
    state: source,
    session,
  }) : []

  if (behind[0]) {
    return refuse({
      message: `${behind[0].id} is queued behind ${card.id}'s worker`,
      help: `Run \`pnyx-axi task unqueue ${behind[0].id} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  const prerequisite = card.prerequisites?.[0]

  if (prerequisite) {
    return refuse({
      message: `${card.id} depends on ${prerequisite}, which stays on Hydra ${hydraId}`,
      help: `Run \`pnyx-axi task undepend ${card.id} --on ${prerequisite} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  const dependent = others.find(c => c.prerequisites?.includes(card.id))

  if (dependent) {
    return refuse({
      message: `${dependent.id} depends on ${card.id}`,
      help: `Run \`pnyx-axi task undepend ${dependent.id} --on ${card.id} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  if (card.wait) {
    return refuse({
      message: `${card.id} waits for ${card.wait.task}, which stays on Hydra ${hydraId}`,
      help: `Run \`pnyx-axi task status ${card.id} paused --hold --note "<why>" --hydra ${hydraId}\` to end the wait, then \`${rerun}\``,
    })
  }

  const waiting = others.find(c => c.wait?.task === card.id)

  if (waiting) {
    return refuse({
      message: `${waiting.id} waits for ${card.id}`,
      help: `Run \`pnyx-axi task status ${waiting.id} paused --hold --note "<why>" --hydra ${hydraId}\` to end its wait, then \`${rerun}\``,
    })
  }

  if (card.parentId) {
    return refuse({
      message: `${card.id} is a subtask of ${card.parentId}, which stays on Hydra ${hydraId}`,
      help: 'Subtasks and their parent cannot move between Hydras',
    })
  }

  const child = others.find(c => c.parentId === card.id)

  if (child) {
    return refuse({
      message: `${card.id} has subtask ${child.id}, which would stay on Hydra ${hydraId}`,
      help: 'Subtasks and their parent cannot move between Hydras',
    })
  }

  const liveSource = card.externalSources?.find(s => LIVE_SOURCE_STATES.has(s.state))

  if (liveSource) {
    return refuse({
      message: `external source ${liveSource.id} still runs for ${card.id} on Hydra ${hydraId}`,
      help: `Run \`pnyx-axi task source stop ${card.id} ${liveSource.id} --hydra ${hydraId}\`, then \`${rerun}\``,
    })
  }

  return undefined
}

function checkTarget({
  hydraId,
  to,
}: {
  hydraId: string
  to: string
}): void {
  if (to === hydraId) {
    throw refuse({
      message: `the task is already on Hydra ${to}`,
      help: 'Name another Hydra with --to-hydra',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!hydraIds().includes(to)) {
    throw refuse({
      message: `Hydra not found: ${to}`,
      help: 'Run `pnyx-axi hydra list` for Hydra ids',
      code: 'NOT_FOUND',
    })
  }
}

// Ends the source's idle live session, so only the target resumes it. A server not running this Hydra holds none.
async function releaseWorker({
  hydraId,
  card,
  actor,
  rerun,
}: {
  hydraId: string
  card: Card
  actor: string
  rerun: string
}): Promise<void> {
  if (card.agent?.host !== 'pnyx') {
    return
  }

  let released: Record<string, unknown>

  try {
    released = await askHost({
      hydraId,
      body: {
        action: 'release',
        task: card.id,
        actor,
      },
    })
  } catch (error) {
    if (error instanceof HydraError && error.code === 'NOT_RUNNING') {
      return
    }

    throw error
  }

  if (typeof released.busy === 'string') {
    throw refuse({
      message: `${card.id}'s worker is ${released.busy}`,
      help: `Wait for it to finish (\`pnyx-axi task show ${card.id} --hydra ${hydraId}\`), then run \`${rerun}\``,
    })
  }
}

// The target's arrival line for this card when the source's departure line was never written.
function unfinishedMove({
  hydraId,
  to,
  source,
  card,
}: {
  hydraId: string
  to: string
  source: HydraState
  card: Card
}): string | undefined {
  if (!loadHydra({ hydraId: to }).state.cards[card.id]) {
    return undefined
  }

  const arrival = readEvents({ hydraId: to })
    .findLast(event => event.type === 'task.moved-in' && event.cardId === card.id)
  const cut = arrival?.type === 'task.moved-in' && arrival.data.from === hydraId && !(arrival.id in source.eventIds)

  return cut ? arrival.id : undefined
}

// Every session the card has had, and when its owner questions were last reminded, as the source holds them.
function carried({
  hydraId,
  state,
  card,
}: {
  hydraId: string
  state: HydraState
  card: Card
}) {
  const members = taskSessions({
    hydraId,
    ids: new Set([card.id]),
  })
  const prefix = `${card.id}:`
  const reminded = {
    ...state.hydraReview?.reminders,
    ...state.questionReminders,
  }

  return {
    sessions: Object.values(state.sessions ?? {}).filter(s => members.has(s.id))
      .map(s => structuredClone(s)),
    reminders: Object.fromEntries(Object.entries(reminded)
      .filter(([key]) => key.startsWith(prefix))),
  }
}

function depart({
  hydraId,
  source,
  card,
  to,
  move,
  meta,
}: {
  hydraId: string
  source: Writer
  card: Card
  to: string
  move: string
  meta: Meta
}): void {
  source.append({
    event: {
      ...base({
        state: source.state,
        meta: {
          ...meta,
          id: move,
        },
        cardId: card.id,
      }),
      type: 'task.moved-out',
      data: {
        to,
        card: structuredClone(card),
        sessions: carried({
          hydraId,
          state: source.state,
          card,
        }).sessions,
      },
    },
    effects: false,
  })
}

function receipt({
  card,
  hydraId,
  to,
  column,
  move,
}: {
  card: Card
  hydraId: string
  to: string
  column: Column
  move: string
}): Output {
  return {
    moved: card.id,
    title: card.title,
    from: hydraId,
    to,
    column,
    event: move,
    copy: card.copy?.state === 'removed' ? 'none' : card.copy?.path ?? 'none',
    worker: card.sessionIds?.[0] ?? 'none',
    help: [`Run \`pnyx-axi task show ${card.id} --hydra ${to}\``],
  }
}

// Writes the target side first, inside the source's write, so a refusal on either side leaves both logs unchanged.
// A crash between the two lines leaves the card on both; running the move again writes the missing source line.
export async function moveTask({
  hydraId,
  ref,
  to,
  meta,
}: {
  hydraId: string
  ref: string
  to: string
  meta: Meta
}): Promise<Output> {
  checkTarget({
    hydraId,
    to,
  })
  const state = loadHydra({ hydraId }).state
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']
  const gone = movedAway({
    state,
    ref,
  })

  if (!card && gone && gone.move === meta.id) {
    return {
      moved: gone.id,
      to: gone.to,
      event: gone.move,
      state: 'unchanged',
    }
  }

  if (!card && gone) {
    throw refuse({
      message: `${ref} moved to Hydra ${gone.to}`,
      help: `Run \`pnyx-axi task move ${gone.id} --to-hydra ${to} --hydra ${gone.to}\``,
      code: 'NOT_FOUND',
    })
  }

  if (!card) {
    throw missing({
      hydraId,
      ref,
    })
  }

  const unfinished = unfinishedMove({
    hydraId,
    to,
    source: state,
    card,
  })

  if (unfinished) {
    await releaseWorker({
      hydraId,
      card,
      actor: meta.actor,
      rerun: rerunCommand({
        card,
        to,
        hydraId,
      }),
    })

    return withWriter({
      hydraId,
      fn: ({ writer: source }) => {
        depart({
          hydraId,
          source,
          card,
          to,
          move: unfinished,
          meta,
        })

        return receipt({
          card,
          hydraId,
          to,
          column: loadHydra({ hydraId: to }).state.cards[card.id]!.column,
          move: unfinished,
        })
      },
    })
  }

  const target = loadHydra({ hydraId: to }).state
  const move = meta.id ?? `move:${randomUUID()}`

  if (move in state.eventIds || move in target.eventIds) {
    throw refuse({
      message: `event id ${move} is already in use`,
      help: 'Repeat the command without --event-id, or with a new one',
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }

  const early = refusal({
    hydraId,
    to,
    source: state,
    target,
    card,
  })

  if (early) {
    throw early
  }

  await releaseWorker({
    hydraId,
    card,
    actor: meta.actor,
    rerun: rerunCommand({
      card,
      to,
      hydraId,
    }),
  })

  // The release ran the source host; nothing awaits from here, so no turn can start before both lines are written.
  return withWriter({
    hydraId,
    fn: ({ writer: source }) => {
      // The source records the transcript up to now, so the target reads on from the same place.
      harvestTranscripts({
        writer: source,
        cardIds: [card.id],
        at: meta.at,
      })
      const current = source.state.cards[card.id]

      if (!current) {
        throw missing({
          hydraId,
          ref,
        })
      }

      const moved = withWriter({
        hydraId: to,
        fn: ({ writer: target }) => {
          const late = refusal({
            hydraId,
            to,
            source: source.state,
            target: target.state,
            card: current,
          })

          if (late) {
            throw late
          }

          const event = {
            ...base({
              state: target.state,
              meta: {
                ...meta,
                id: move,
              },
              cardId: current.id,
            }),
            type: 'task.moved-in',
            data: {
              from: hydraId,
              column: targetColumn({
                source: source.state,
                target: target.state,
                card: current,
              }),
              card: structuredClone(current),
              ...carried({
                hydraId,
                state: source.state,
                card: current,
              }),
            },
          } satisfies HydraMoveEvent
          target.append({
            event,
            effects: false,
          })
          carryCursors({
            from: source.dir,
            to: target.dir,
            card: current.id,
          })

          return event
        },
      })

      depart({
        hydraId,
        source,
        card: current,
        to,
        move,
        meta,
      })

      return receipt({
        card: current,
        hydraId,
        to,
        column: moved.data.column,
        move,
      })
    },
  })
}
