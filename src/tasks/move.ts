import { nativeHome } from '#app/native-home.ts'
import { inform } from '#app/command-notices.ts'
import { prepareTaskRuntimeMove } from '#app/task-runtime.ts'
import { applyDecision } from '#app/decision.ts'
import { decideSession } from '#workers/sessions.ts'
import { captureResult } from '#task-sources/sources.ts'
import { foldWorkerLog, workerTaskDir } from '#workers/worker-log.ts'
import { randomUUID } from 'node:crypto'
import type { TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { base } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { askHost } from '#app/server-state.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { carryCursors, harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { TitanError } from '#store/errors.ts'
import { projectsFor } from '#projects/read.ts'
import { matchesProject, sameProjectPath } from '#projects/identity.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { taskSessions } from '#workers/session-history.ts'
import { workerQueue } from '#workers/queue.ts'
import type { Card } from './model.ts'
import { movedAway, type TitanMoveEvent, type MovedCard } from './move-state.ts'
import { isManagedTask } from './select.ts'
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
}) => new TitanError({
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
  help: `Use othrys board --titan ${hydraId}`,
  code: 'NOT_FOUND',
})

function projectOnTarget({
  source,
  target,
  label,
}: {
  source: TitanState
  target: TitanState
  label: string
}): {
  path: string
  attached: boolean
} {
  const own = projectsFor({ state: source }).find(p => matchesProject({
    project: p,
    ref: label,
  }))
  const attached = projectsFor({ state: target }).filter(p => !p.detached)

  if (!own) {
    return {
      path: label,
      attached: attached.some(p => matchesProject({
        project: p,
        ref: label,
      })),
    }
  }

  return {
    path: own.path,
    attached: attached.some(p => sameProjectPath({
      left: p.path,
      right: own.path,
    })),
  }
}

// Every reason a move would leave something broken, each with the command that clears it.
export function moveRefusal({
  hydraId,
  to,
  source,
  target,
  card,
  moving = [],
}: {
  hydraId: string
  to: string
  source: TitanState
  target: TitanState
  card: Card
  moving?: string[]
}): TitanError | undefined {
  const others = Object.values(source.cards).filter(c => c.id !== card.id && !moving.includes(c.id))
  const restoreRelationships = `After moving from Titan ${hydraId} to ${to}, review the previous relationships in the destination's tasks/${card.id}/task.log`
  const session = card.sessionIds?.[0]

  if (isManagedTask({ card })) {
    return refuse({
      message: `${card.id} is not an explicit task`,
      help: 'Choose a task in the UI',
      code: 'VALIDATION_ERROR',
    })
  }

  const project = card.project && projectOnTarget({
    source,
    target,
    label: card.project,
  })

  if (project && !project.attached && !moving.includes(card.id)) {
    inform({
      task: card.id,
      reason: `Moved with: Titan ${to} has no project ${project.path} attached`,
      clear: restoreRelationships,
    })
  }

  const conflictingTask = target.cards[card.id]?.id ?? target.keys[card.key]

  if (conflictingTask) {
    return refuse({
      message: `Titan ${to} already has a task with id or key ${card.id}`,
      help: `Read tasks/${conflictingTask}/task.log in Titan ${to}`,
    })
  }

  if (session && card.agent?.host !== 'othrys') {
    inform({
      task: card.id,
      reason: `Detached ${card.id}'s outside worker; its hooks retain Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  if (activeHelperBatches({ state: source }).some(batch => batch.tasks.includes(card.id))) {
    inform({
      task: card.id,
      reason: `Moved with: the routine helper is handling ${card.id}`,
      clear: restoreRelationships,
    })
  }

  if (card.queue) {
    inform({
      task: card.id,
      reason: `Removed the queue entry for ${card.id}, previously behind ${card.queue.session}`,
      clear: restoreRelationships,
    })
  }

  const behind = session ? workerQueue({
    state: source,
    session,
  }) : []

  if (behind[0]) {
    inform({
      task: card.id,
      reason: `Moved with: ${behind[0].id} is queued behind ${card.id}'s worker`,
      clear: restoreRelationships,
    })
  }

  const prerequisite = card.prerequisites?.find(id => !moving.includes(id))

  if (prerequisite) {
    inform({
      task: card.id,
      reason: `Moved with: ${card.id} depends on ${prerequisite}, which stays on Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  const dependent = others.find(c => c.prerequisites?.includes(card.id))

  if (dependent) {
    inform({
      task: card.id,
      reason: `Moved with: ${dependent.id} depends on ${card.id}`,
      clear: restoreRelationships,
    })
  }

  if (card.wait && !moving.includes(card.wait.task)) {
    inform({
      task: card.id,
      reason: `Moved with: ${card.id} waits for ${card.wait.task}, which stays on Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  const waiting = others.find(c => c.wait?.task === card.id)

  if (waiting) {
    inform({
      task: card.id,
      reason: `Moved with: ${waiting.id} waits for ${card.id}`,
      clear: restoreRelationships,
    })
  }

  if (card.parentId && !moving.includes(card.parentId)) {
    inform({
      task: card.id,
      reason: `Moved with: ${card.id} is a subtask of ${card.parentId}, which stays on Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  const child = others.find(c => c.parentId === card.id && !isManagedTask({ card: c }))

  if (child) {
    inform({
      task: card.id,
      reason: `Moved with: ${card.id} has subtask ${child.id}, which would stay on Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  const liveSource = card.externalSources?.find(s => LIVE_SOURCE_STATES.has(s.state))

  if (liveSource) {
    inform({
      task: card.id,
      reason: `Moved with: external source ${liveSource.id} still runs for ${card.id} on Titan ${hydraId}`,
      clear: restoreRelationships,
    })
  }

  return undefined
}

function checkTarget({
  to,
}: {
  to: string
}): void {
  if (!hydraIds().includes(to)) {
    throw refuse({
      message: `Titan not found: ${to}`,
      help: 'Choose a destination Titan in the UI',
      code: 'NOT_FOUND',
    })
  }
}

// Ends the source's idle live session, so only the target resumes it. A server not running this Titan holds none.
export async function releaseWorker({
  hydraId,
  card,
  actor,
}: {
  hydraId: string
  card: Card
  actor: string
}): Promise<void> {
  if (card.agent?.host !== 'othrys') {
    return
  }

  let released: Record<string, unknown>

  try {
    released = await askHost({
      hydraId,
      body: {
        action: 'release',
        permanent: true,
        task: card.id,
        actor,
      },
    })
  } catch (error) {
    if (error instanceof TitanError && error.code === 'NOT_RUNNING') {
      return
    }

    throw error
  }

  if (typeof released.busy === 'string') {
    throw refuse({
      message: `${card.id}'s worker is ${released.busy}`,
      help: `Check worker activity for task ${card.id} in Titan ${hydraId} in the UI. Retry the move when the worker is idle.`,
    })
  }
}

// A move cut between its two lines leaves the card on both Titans. Running it again replaces the target's
// untouched copy with the source's current card; a copy edited on both sides since is left for the owner.
// Every session the card has had, and when its owner questions were last reminded, as the source holds them.
function carried({
  hydraId,
  state,
  card,
}: {
  hydraId: string
  state: TitanState
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
  moving,
}: {
  hydraId: string
  source: Writer
  card: Card
  to: string
  move: string
  meta: Meta
  moving?: MovedCard['moving']
}): void {
  const data: Extract<TitanMoveEvent, { type: 'task.moved-out' }>['data'] = {
    to,
    card: structuredClone(card),
    sessions: carried({
      hydraId,
      state: source.state,
      card,
    }).sessions,
  }

  if (moving) {
    data.moving = moving
  }

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
      data,
    },
    effects: false,
  })
}

function receipt({
  card,
  hydraId,
  to,
  move,
}: {
  card: Card
  hydraId: string
  to: string
  move: string
}): Output {
  return {
    moved: card.id,
    title: card.title,
    from: hydraId,
    to,
    event: move,
    copy: card.copy?.state === 'removed' ? 'none' : card.copy?.path ?? 'none',
    worker: card.sessionIds?.[0] ?? 'none',
    help: [`Read tasks/${card.id}/task.log in Titan ${to}`],
  }
}

export function stageTaskMove({
  hydraId,
  source,
  target,
  cardId,
  to,
  move,
  meta,
  moving,
}: {
  hydraId: string
  source: Writer
  target: Writer
  cardId: string
  to: string
  move: string
  meta: Meta
  moving?: MovedCard['moving']
}): TitanMoveEvent & { type: 'task.moved-in' } {
  // The source records the transcript's notes up to now, so the target reads on from the same place.
  harvestTranscripts({
    writer: source,
    cardIds: [cardId],
    at: meta.at,
  })
  // After the harvest's own cursors are saved, which happens once this write commits.
  source.afterCommit({
    run: () => carryCursors({
      from: source.dir,
      to: hydraDir({ hydraId: to }),
      card: cardId,
    }),
  })
  foldWorkerLog({
    writer: source,
    task: cardId,
  })
  let current = source.state.cards[cardId]

  if (!current) {
    throw missing({
      hydraId,
      ref: cardId,
    })
  }

  const late = moveRefusal({
    hydraId,
    to,
    source: source.state,
    target: target.state,
    card: current,
  })

  if (late) {
    throw late
  }

  for (const external of current.externalSources ?? []) {
    if (LIVE_SOURCE_STATES.has(external.state)) {
      captureResult({
        writer: source,
        card: current,
        source: external,
        run: external.run?.id ?? external.registration,
        outcome: 'stopped',
        detail: 'Stopped for a Titan move; unread results remain recorded',
        meta,
      })
    }
  }

  if (current.agent?.host !== 'othrys') {
    for (const session of [...current.sessionIds ?? []]) {
      applyDecision({
        writer: source,
        decision: decideSession({
          state: source.state,
          ref: session,
          task: null,
          meta: {
            ...meta,
            id: undefined,
            ifRevision: undefined,
          },
        }),
      })
    }
  }

  current = source.state.cards[cardId]!

  const arriving = nativeHome().cardForMove({
    from: hydraId,
    to,
    card: current,
    state: target.state,
  })
  const event: Extract<TitanMoveEvent, { type: 'task.moved-in' }> = {
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
      card: {
        ...arriving,
        workerLogDir: workerTaskDir({
          hydraId,
          task: cardId,
        }),
      },
      ...carried({
        hydraId,
        state: source.state,
        card: current,
      }),
    },
  }

  if (moving) {
    event.data.moving = moving
  }

  const moveRuntime = prepareTaskRuntimeMove({
    task: cardId,
    from: hydraId,
    to,
  })

  if (moveRuntime) {
    source.afterCommit({
      run: () => moveRuntime({ card: target.state.cards[cardId]! }),
    })
  }

  target.append({
    event,
    effects: false,
  })

  depart({
    hydraId,
    source,
    card: current,
    to,
    move,
    meta,
    moving,
  })

  return event
}

// Both Titan sequence claims, events and rows commit together; a refusal leaves the task on its source.
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
    to,
  })
  const state = loadTitan({ hydraId }).state
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
      message: `${ref} moved to Titan ${gone.to}`,
      help: `Review task ${gone.id} on Titan ${gone.to} in the UI`,
      code: 'NOT_FOUND',
    })
  }

  if (!card) {
    throw missing({
      hydraId,
      ref,
    })
  }

  if (to === hydraId) {
    inform({
      task: card.id,
      reason: `Task is already on Titan ${to}`,
      clear: `Review the Titan of task ${card.id} in the UI.`,
    })

    return {
      moved: card.id,
      to,
      event: 'none: unchanged',
      state: 'unchanged',
    }
  }

  const target = loadTitan({ hydraId: to }).state
  const move = meta.id ?? `move:${randomUUID()}`

  if (Object.hasOwn(
    state.eventIds,
    move,
  ) || Object.hasOwn(
    target.eventIds,
    move,
  )) {
    throw refuse({
      message: `event id ${move} is already in use`,
      help: 'Repeat the command without --event-id, or with a new one',
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }

  const early = moveRefusal({
    hydraId,
    to,
    source: state,
    target,
    card,
  })

  if (early) {
    throw early
  }

  if (!prepareTaskRuntimeMove({
    task: card.id,
    from: hydraId,
    to,
  })) {
    await releaseWorker({
      hydraId,
      card,
      actor: meta.actor,
    })
  }

  return await withWriter({
    hydraId,
    also: [to],
    fn: ({
      writer: source,
      writers,
    }) => {
      const target = writers.get(to)!
      const event = stageTaskMove({
        hydraId,
        source,
        target,
        cardId: card.id,
        to,
        move,
        meta,
      })
      const current = event.data.card

      return receipt({
        card: current,
        hydraId,
        to,
        move,
      })
    },
  })
}

// Follows a moved task from Titan to Titan to the one that holds it now; undefined once the trail ends.
export function currentHolder({
  hydraId,
  state,
  card,
}: {
  hydraId: string
  state: TitanState
  card: string
}): string | undefined {
  const seen = new Set<string>()
  let at: string | undefined = hydraId
  let current = state

  while (at && !seen.has(at)) {
    if (current.cards[card]) {
      return at
    }

    seen.add(at)
    at = current.movedOut?.[card]?.to

    if (at && !hydraIds().includes(at)) {
      return undefined
    }

    if (at) {
      current = loadTitan({ hydraId: at }).state
    }
  }

  return undefined
}
