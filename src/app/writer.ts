import type { Output } from './cli-support.ts'
import { transactionReceipt, transactionStatement } from './transactions.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { LABEL_COLORS } from '#tasks/model.ts'
import { requireHydra, writableHydra, reloadHydra } from './store.ts'
import { query, storable } from '#store/postgres.ts'
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
import { rememberEvents } from './event-log.ts'
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
  transaction?: {
    id: string
    digest: string
  }
  migrate?: boolean
  fn({ writer }: { writer: Writer }): T
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
  // Leases and locks keep their files in the Hydra's folder, which no other write creates.
  privateDir({
    dir: hydraDir({
      hydraId,
      migrate,
    }),
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

  const from = live.state.seq
  const pending: HydraEvent[] = []
  const committed: (() => void)[] = []
  const touched: Touched = {
    cards: new Set(),
    fields: new Set(),
  }
  const writer = eventWriter({
    state: live.state,
    owned: true,
    dir: live.dir,
    hydraId,
    transaction: transaction?.id,
    touched,
    committed,
    onAppend: ({ event }) => {
      pending.push(event)
    },
  })
  let result: T

  try {
    // A Hydra still on an older layout moves onto the default columns before its next write.
    const migrated = migrate ? migrateColumns({
      state: writer.state,
      meta: {
        at: new Date().toISOString(),
        actor: 'pnyx',
      },
    }) : { skipped: 'unchanged' }

    if ('event' in migrated) {
      writer.append({ event: migrated.event })
    }

    result = fn({ writer })

    if (pending.length) {
      const started = performance.now()

      if (from === 0) {
        rememberFirstEvent({
          hydraId,
          event: pending[0]!,
        })
      }

      // A Hydra's first write saves every row, including the fields its empty state starts with.
      const changes = rowChanges({
        hydraId,
        state: live.state,
        saved: live.saved,
        touched: from === 0 ? undefined : touched,
      })
      checkTouched({
        hydraId,
        state: live.state,
        saved: changes.next,
      })
      const statements = [
        ...eventStatements({
          hydraId,
          from,
          to: live.state.seq,
          events: pending,
        }),
        ...changes.statements,
      ]

      if (transaction) {
        statements.push(transactionStatement({
          hydraId,
          ...transaction,
          receipt: result as Output,
        }))
      }

      query({
        transaction: true,
        statements,
      })
      live.saved = changes.next
      live.committed = live.state.seq
      rememberEvents({
        hydraId,
        from,
        events: pending,
      })
      log({
        operation: 'events.write',
        hydraId,
        name: pending.at(-1)!.type,
        eventSeq: live.state.seq,
        count: pending.length,
        ms: performance.now() - started,
      })
    }
  } catch (error) {
    if (pending.length) {
      reloadHydra({ hydraId })
    }

    throw error
  }

  // The write has committed, so a step after it that fails is logged and the rest, and the page's update, still run.
  for (const run of committed) {
    try {
      run()
    } catch (error) {
      log({
        level: 'error',
        operation: 'events.after-commit',
        hydraId,
        error,
      })
    }
  }

  if (pending.length) {
    live.changed()
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
