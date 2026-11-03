import type { Output } from './cli-support.ts'
import { transactionReceipt } from './transactions.ts'
import { EVENT_VERSION } from '#store/events.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { LABEL_COLORS } from '#tasks/model.ts'
import { hydraDir } from './home-migration.ts'
import { requireHydra, loadTail, heldHydra, type Held } from './store.ts'
import { readLog } from './event-log.ts'
import { existsSync, statSync } from 'node:fs'
import { privateDir, acquireLock, writeDurably, logPath } from '#store/storage.ts'
import { migrateColumns } from '#tasks/column-rules.ts'
import { declareTask } from '#tasks/declarations.ts'
import { agentActor } from '#hydra/hydra.ts'
import { isHelper, guardTaskLease, deliveringMessage } from '#routine-helper/leases.ts'
import { helperGrant } from '#routine-helper/route.ts'
import { labelsForEvent } from '#tasks/labels.ts'
import { randomInt } from 'node:crypto'
import { emptyHydra, replayOwned } from './reducer.ts'
import { preimage, type PreimageObserver } from './preimage.ts'
import { reconcileAsks } from '#tasks/questions.ts'
import { operationDeclarations, lifecycleMoves, lifecycleMoveId } from '#tasks/lifecycle.ts'
import { decideMove } from '#tasks/columns-decisions.ts'
import { writeSnapshot } from './snapshot.ts'

const MESSAGE_EVENTS = new Set<string>([
  'card.replied',
  'task.steering.queued',
  'task.steering.notified',
])

export interface Writer {
  readonly state: HydraState
  readonly dir: string
  append({
    event,
    effects,
  }: {
    event: HydraEvent
    effects?: boolean
  }): void
}

interface WriterOptions<T> {
  hydraId: string
  create?: boolean
  lockTimeout?: number
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

// A transaction stages all derived events before appending its one durable line.
export function withWriter<T>({
  hydraId,
  fn,
  create = false,
  lockTimeout,
  transaction,
  migrate = true,
}: WriterOptions<T>): T | Output {
  const live = heldHydra({ hydraId })

  if (live) {
    return heldWrite({
      live,
      hydraId,
      fn,
      transaction,
      migrate,
    })
  }

  const dir = hydraDir({
    hydraId,
    migrate,
  })

  if (!create) {
    requireHydra({
      hydraId,
      migrate,
    })
  }

  privateDir({ dir })
  const release = acquireLock({
    dir,
    timeout: lockTimeout,
  })

  try {
    let {
      state,
      offset,
    } = loadTail({
      hydraId,
      migrate,
    })

    if (transaction) {
      const previous = transactionReceipt({
        hydraId,
        ...transaction,
        migrate,
      })

      if (previous) {
        // A complete record may come from a writer killed before its fsync.
        writeDurably({
          path: logPath({ dir }),
          data: '',
          flag: 'a',
        })

        return previous
      }
    }

    let dirty = false
    let current: Writer | undefined

    try {
      const pending: HydraEvent[] = []
      const writer = eventWriter({
        state,
        dir,
        hydraId,
        owned: true,
        transaction: transaction?.id,
        onAppend: ({ event }) => {
          if (transaction) {
            pending.push(event)

            return
          }

          const line = `${JSON.stringify(event)}\n`
          writeDurably({
            path: logPath({ dir }),
            data: line,
            flag: 'a',
          })
          offset += Buffer.byteLength(line)
          dirty = true
        },
      })
      current = writer
      // A Hydra still on an older layout moves onto the default columns before its next write.
      const migrated = migrate ? migrateColumns({
        state,
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      }) : { skipped: 'unchanged' }

      if ('event' in migrated) {
        writer.append({ event: migrated.event })
      }

      const result = fn({ writer })

      if (transaction) {
        const line = `${JSON.stringify({
          v: EVENT_VERSION,
          type: 'log.transaction',
          ...transaction,
          events: pending,
          receipt: result,
        })}\n`
        writeDurably({
          path: logPath({ dir }),
          data: line,
          flag: 'a',
        })
        offset += Buffer.byteLength(line)
        dirty = true
      }

      state = writer.state

      return result
    } finally {
      if (dirty) {
        writeSnapshot({
          dir,
          state: current?.state ?? state,
          offset,
        })
      }
    }
  } finally {
    release()
  }
}

// How long after a write the server saves the Hydra's snapshot; the log already holds every change.
const SNAPSHOT_DELAY_MS = 2000
const snapshotTimers = new WeakMap<Held, ReturnType<typeof setTimeout>>()

// Saves a held Hydra's snapshot now; the server calls it when it lets the Hydra go.
export function saveSnapshot({ live }: { live: Held }): void {
  clearTimeout(snapshotTimers.get(live))
  snapshotTimers.delete(live)
  writeSnapshot({
    dir: live.dir,
    state: live.state,
    offset: live.offset,
  })
}

// A write to a Hydra the server holds: no lock and no reload. Each line is fsynced before it applies; a transaction
// works on a copy that replaces the live state only once its line is on disk.
function heldWrite<T>({
  live,
  hydraId,
  fn,
  transaction,
  migrate,
}: {
  live: Held
  hydraId: string
  fn({ writer }: { writer: Writer }): T
  transaction?: {
    id: string
    digest: string
  }
  migrate: boolean
}): T | Output {
  const path = logPath({ dir: live.dir })

  // Another process (a CLI that ran while the server was down) appended; take its lines first.
  if ((existsSync(path) ? statSync(path).size : 0) !== live.offset) {
    // A log that no longer starts where it did, as after repair, is read again from its start.
    let tail = readLog({
      dir: live.dir,
      from: live.offset,
    }) ?? readLog({ dir: live.dir })!

    // New lines that do not follow the held state mean the log changed under it: rebuild from the start.
    if (tail.events[0] && tail.events[0].seq !== live.state.seq + 1) {
      live.state = emptyHydra()
      tail = readLog({ dir: live.dir })!
    }

    if (tail.size !== tail.end) {
      throw new HydraError({
        message: `events.jsonl ends with ${tail.size - tail.end} bytes of a torn append`,
        code: 'TORN_TAIL',
        help: ['Run `pnyx-axi repair` to set them aside and continue'],
      })
    }

    replayOwned({
      state: live.state,
      events: tail.events,
    })
    live.offset = tail.end
  }

  if (transaction) {
    const previous = transactionReceipt({
      hydraId,
      ...transaction,
      migrate,
    })

    if (previous) {
      return previous
    }
  }

  let offset = live.offset
  let dirty = false
  const pending: HydraEvent[] = []
  const writer = eventWriter({
    state: transaction ? structuredClone(live.state) : live.state,
    dir: live.dir,
    hydraId,
    owned: true,
    transaction: transaction?.id,
    onAppend: ({ event }) => {
      if (transaction) {
        pending.push(event)

        return
      }

      const line = `${JSON.stringify(event)}\n`
      writeDurably({
        path,
        data: line,
        flag: 'a',
      })
      offset += Buffer.byteLength(line)
      live.offset = offset
      dirty = true
    },
  })

  try {
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

    const result = fn({ writer })

    if (transaction) {
      const line = `${JSON.stringify({
        v: EVENT_VERSION,
        type: 'log.transaction',
        ...transaction,
        events: pending,
        receipt: result,
      })}\n`
      writeDurably({
        path,
        data: line,
        flag: 'a',
      })
      live.state = writer.state
      live.offset = offset + Buffer.byteLength(line)
      dirty = true
    }

    return result
  } finally {
    if (dirty) {
      clearTimeout(snapshotTimers.get(live))
      snapshotTimers.set(
        live,
        setTimeout(
          () => {
            // The log holds the change; a snapshot that cannot be written is only a slower next start.
            try {
              saveSnapshot({ live })
            } catch (error) {
              console.error(`pnyx-axi snapshot of Hydra ${hydraId}: ${(error as Error).message}`)
            }
          },
          SNAPSHOT_DELAY_MS,
        ).unref(),
      )
      live.changed()
    }
  }
}

export function eventWriter({
  state: initial,
  owned = false,
  dir,
  hydraId,
  transaction,
  onAppend,
}: {
  state: HydraState
  owned?: boolean
  dir: string
  hydraId: string
  transaction?: string
  onAppend({ event }: { event: HydraEvent }): void
}): Writer {
  const state = owned ? initial : structuredClone(initial)
  const observers = new Set<PreimageObserver>()
  const writer: Writer = {
    dir,
    get state() {
      return state
    },
    append({
      event,
      effects = true,
    }) {
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

      if (transaction && Object.hasOwn(
        state.eventIds,
        event.id,
      )) {
        throw new HydraError({
          message: `event id ${event.id} already exists`,
          code: 'IDEMPOTENCY_CONFLICT',
        })
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
          writer.append({ event: question })
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
