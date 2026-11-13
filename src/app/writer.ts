import type { Output } from './cli-support.ts'
import { transactionReceipt, transactionStatement } from './transactions.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { LABEL_COLORS } from '#tasks/model.ts'
import { requireHydra, writableHydra, reloadHydra } from './store.ts'
import { query, storable, type QueryTimings } from '#store/postgres.ts'
import { privateDir } from '#store/storage.ts'
import { hydraDir } from './home-migration.ts'
import { migrateColumns } from '#tasks/column-rules.ts'
import { declareTask } from '#tasks/declarations.ts'
import { agentActor } from '#hydra/hydra.ts'
import { isHelper, guardTaskLease, deliveringMessage } from '#routine-helper/leases.ts'
import { helperGrant } from '#routine-helper/route.ts'
import { labelsForEvent } from '#tasks/labels.ts'
import { randomInt } from 'node:crypto'
import { replayOwned } from './reducer.ts'
import { preimage, type PreimageObserver, type Touched } from './preimage.ts'
import { reconcileAsks } from '#tasks/delivery/merge-questions.ts'
import { operationDeclarations, lifecycleMoves, lifecycleMoveId } from '#tasks/lifecycle.ts'
import { decideMove } from '#tasks/columns-decisions.ts'
import { eventStatements, rowChanges, type SavedRows } from './rows.ts'
import { log } from './diagnostics.ts'
import { rememberFirstEvent } from './hydra-summary.ts'

const MESSAGE_EVENTS = new Set<string>([
  'card.replied',
  'task.steering.queued',
  'task.steering.notified',
])

export interface Writer {
  readonly state: HydraState
  readonly dir: string
  // Work outside Postgres, such as removing an ingested spool file, that must happen only once the write commits.
  afterCommit({ run }: { run(): void }): void
  append({
    event,
    effects,
  }: {
    event: HydraEvent
    effects?: boolean
  }): void
}

// Tests set this, so every write in the suite proves that comparing every row finds nothing the touched rows missed.
const CHECK_ROWS = 'PNYX_CHECK_ROWS'

function checkTouched({
  hydraId,
  state,
  saved,
}: {
  hydraId: string
  state: HydraState
  saved: SavedRows
}): void {
  if (!process.env[CHECK_ROWS]) {
    return
  }

  const missed = rowChanges({
    hydraId,
    state,
    saved,
  }).statements

  if (missed.length) {
    throw new Error(`a write changed rows it did not mark: ${missed.map(statement => statement.text.split('\n')[0]).join('; ')}`)
  }
}

interface WriterOptions<T> {
  hydraId: string
  create?: boolean
  also?: string[]
  transaction?: {
    id: string
    digest: string
  }
  migrate?: boolean
  fn({
    writer,
    writers,
  }: {
    writer: Writer
    writers: ReadonlyMap<string, Writer>
  }): T
}

export function withWriter<T>({ fn }: WriterOptions<T> & { transaction?: undefined }): T
export function withWriter({ fn }: WriterOptions<Output> & {
  transaction: {
    id: string
    digest: string
  }
}): Output

// One command's write: its events and the rows they changed commit in one Postgres transaction, which moves the
// Hydra's seq only from the value this write started at. The state in memory changes as the events apply; a write
// that throws or fails to commit reads the Hydra back from its committed rows.
export function withWriter<T>({
  hydraId,
  fn,
  create = false,
  also = [],
  transaction,
  migrate = true,
}: WriterOptions<T>): T | Output {
  if (!create) {
    requireHydra({ hydraId })
  }

  const live = writableHydra({
    hydraId,
    migrate,
  })

  if (transaction) {
    const previous = transactionReceipt({
      hydraId,
      ...transaction,
      eventIds: live.state.eventIds,
    })

    if (previous) {
      return previous
    }
  }

  const stages = [
    ...new Set([
      hydraId,
      ...also,
    ]),
  ].sort().map(id => {
    if (id !== hydraId) {
      requireHydra({ hydraId: id })
    }

    const held = id === hydraId ? live : writableHydra({
      hydraId: id,
      migrate,
    })
    privateDir({
      dir: hydraDir({
        hydraId: id,
        migrate,
      }),
    })
    const pending: HydraEvent[] = []
    const committed: (() => void)[] = []
    const touched: Touched = {
      cards: new Set(),
      fields: new Set(),
    }
    const writer = eventWriter({
      state: held.state,
      owned: true,
      dir: held.dir,
      hydraId: id,
      transaction: id === hydraId ? transaction?.id : undefined,
      touched,
      committed,
      onAppend: ({ event }) => pending.push(event),
    })

    return {
      id,
      held,
      writer,
      pending,
      committed,
      touched,
      from: held.state.seq,
    }
  })
  const writers = new Map(stages.map(stage => [
    stage.id,
    stage.writer,
  ]))
  const primary = writers.get(hydraId)!
  let result: T
  const started = performance.now()

  try {
    for (const stage of stages) {
      const migrated = migrate ? migrateColumns({
        state: stage.writer.state,
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      }) : { skipped: 'unchanged' }

      if ('event' in migrated) {
        stage.writer.append({ event: migrated.event })
      }
    }

    result = fn({
      writer: primary,
      writers,
    })
    const changes = stages.filter(stage => stage.pending.length).map(stage => {
      const rows = rowChanges({
        hydraId: stage.id,
        state: stage.held.state,
        saved: stage.held.saved,
        touched: stage.from === 0 ? undefined : stage.touched,
      })
      checkTouched({
        hydraId: stage.id,
        state: stage.held.state,
        saved: rows.next,
      })

      return {
        stage,
        rows,
      }
    })
    const statements = changes.flatMap(({
      stage,
      rows,
    }) => [
      ...eventStatements({
        hydraId: stage.id,
        from: stage.from,
        to: stage.held.state.seq,
        events: stage.pending,
      }),
      ...rows.statements,
    ])

    if (transaction && changes.length) {
      statements.push(transactionStatement({
        hydraId,
        ...transaction,
        receipt: result as Output,
      }))
    }

    let timings: QueryTimings | undefined

    if (statements.length) {
      query({
        timed: ({ timings: measured }) => {
          timings = measured
        },
        transaction: true,
        statements,
      })
    }

    for (const {
      stage,
      rows,
    } of changes) {
      log({
        operation: 'events.write',
        connectionWaitMs: timings?.connectionWaitMs,
        commitMs: timings?.commitMs,
        name: stage.pending.at(-1)!.type,
        ms: performance.now() - started,
        hydraId: stage.id,
        eventSeq: stage.held.state.seq,
        count: stage.pending.length,
      })
      stage.held.saved = rows.next
      stage.held.committed = stage.held.state.seq

      if (stage.from === 0) {
        rememberFirstEvent({
          hydraId: stage.id,
          event: stage.pending[0]!,
        })
      }
    }
  } catch (error) {
    for (const stage of stages) {
      if (stage.pending.length) {
        reloadHydra({ hydraId: stage.id })
      }
    }

    throw error
  }

  for (const stage of stages) {
    for (const run of stage.committed) {
      try {
        run()
      } catch (error) {
        log({
          level: 'error',
          operation: 'events.after-commit',
          hydraId: stage.id,
          error,
        })
      }
    }

    if (stage.pending.length) {
      stage.held.changed()
    }
  }

  return result
}

export function eventWriter({
  state: initial,
  owned = false,
  dir,
  hydraId,
  transaction,
  touched,
  committed = [],
  onAppend,
}: {
  state: HydraState
  owned?: boolean
  dir: string
  hydraId: string
  transaction?: string
  touched?: Touched
  committed?: (() => void)[]
  onAppend({ event }: { event: HydraEvent }): void
}): Writer {
  const state = owned ? initial : structuredClone(initial)
  const observers = new Set<PreimageObserver>()
  const writer: Writer = {
    dir,
    get state() {
      return state
    },
    afterCommit: ({ run }) => {
      committed.push(run)
    },
    append({
      event,
      effects = true,
    }) {
      storable({ value: event })
      const harvestedNote = event.actor === 'harvest' && event.type === 'card.noted'
      // A message to a task's agent is never refused for the routine helper's lease; it queues like any message.
      const message = !isHelper({ actor: event.actor })
        && (MESSAGE_EVENTS.has(event.type) || deliveringMessage.getStore() === true)

      if (!agentActor({ actor: event.actor }) && !harvestedNote && !message
        && (event.type !== 'hydra.message' || isHelper({ actor: event.actor }))) {
        const task = event.type === 'hydra.message' ? event.data.task : event.cardId

        if (task && state.cards[task]) {
          guardTaskLease({
            dir,
            task,
            actor: event.actor,
          })
        }

        if (isHelper({ actor: event.actor }) && (!task || !helperGrant({
          state,
          task,
          actor: event.actor,
        }))) {
          throw new HydraError({
            message: 'Helper mutation is outside its task scope',
            code: 'MAIN_ONLY',
          })
        }
      }

      const known = Object.hasOwn(
        state.eventIds,
        event.id,
      )

      if (transaction && known) {
        throw new HydraError({
          message: `event id ${event.id} already exists`,
          code: 'IDEMPOTENCY_CONFLICT',
        })
      }

      // The reducer skips an event it has already applied, so it is not sent again for the events table to refuse.
      if (known) {
        return
      }

      if (event.seq !== state.seq + 1) {
        throw new Error(`append out of sequence: ${event.seq} after ${state.seq}`)
      }

      const knownLabels = new Set(state.labelColors?.map(entry => entry.label))
      const labelColors = labelsForEvent({
        state,
        event,
      })
        .filter(label => !knownLabels.has(label))
        .map(label => ({
          label,
          color: LABEL_COLORS[randomInt(LABEL_COLORS.length)] ?? 'slate',
        }))

      if (labelColors.length && !event.labelColors) {
        event = {
          ...event,
          labelColors,
        }
      }

      const card = state.cards[event.cardId]
      const parent = event.type === 'task.created' ? event.data.parentId : card?.parentId
      const session = event.type === 'task.session' ? event.data.session : card?.sessionIds?.[0]
      let agent = card?.agent

      if (session) {
        agent = state.sessions?.[session]?.agent
      }

      if (event.type === 'card.pushed' && event.data.agent) {
        agent = event.data.agent
      }

      let observedSession = session
      const envelope: Partial<HydraEvent> = {
        boardId: hydraId,
        commandId: event.id,
      }

      if (event.cardId !== '$board') {
        envelope.taskId = parent ?? event.cardId
      }

      if (parent) {
        envelope.subtaskId = event.cardId
      }

      if (agent) {
        const suffix = agent.agentId ? `/${agent.agentId}` : ''
        observedSession = `${agent.provider}:${agent.sessionId}${suffix}`
        envelope.agentId = `${agent.provider}:${agent.agentId ?? agent.sessionId}`
      }

      if (observedSession) {
        envelope.sessionId = observedSession
      }

      if (event.type === 'card.replied') {
        envelope.messageId = event.data.reply
      }

      event = {
        ...envelope,
        ...event,
      }

      if (transaction) {
        event = {
          ...event,
          transaction,
        }
      }

      onAppend({ event })
      const {
        before,
        release,
      } = preimage({
        state,
        observers,
        touched,
        change: ({ state: draft }) => replayOwned({
          state: draft,
          events: [event],
        }),
      })

      try {
        if (!effects) {
          return
        }

        for (const question of reconcileAsks({
          state,
          event,
        })) {
          // Earlier questions can append lifecycle events before the next closure.
          writer.append({
            event: {
              ...question,
              seq: state.seq + 1,
            },
          })
        }

        for (const declaration of operationDeclarations({
          before,
          state,
          event,
        })) {
          const declared = declareTask({
            state,
            ref: declaration.cardId,
            status: declaration.status,
            note: declaration.note,
            until: declaration.until,
            waitingFor: declaration.waitingFor,
            restores: declaration.restores,
            meta: {
              id: `${event.id}:${declaration.cardId}:declaration`,
              at: event.at,
              actor: 'pnyx',
            },
          })

          if ('event' in declared) {
            writer.append({ event: declared.event })
          }
        }

        // A task's explicit lifecycle change moves its card, as its own event in the same write.
        for (const move of lifecycleMoves({
          before,
          state,
          event,
        })) {
          const moved = decideMove({
            state,
            ref: move.cardId,
            column: move.column,
            meta: {
              id: lifecycleMoveId({
                event: event.id,
                cardId: move.cardId,
              }),
              at: event.at,
              actor: 'pnyx',
              reason: move.reason,
            },
          })

          if ('event' in moved) {
            writer.append({ event: moved.event })
          }
        }
      } finally {
        release()
      }
    },
  }

  return writer
}
