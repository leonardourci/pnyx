import type { Output } from './cli-support.ts'
import { transactionReceipt } from './transactions.ts'
import { EVENT_VERSION } from '#store/events.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { LABEL_COLORS } from '#tasks/model.ts'
import { hydraDir } from './home-migration.ts'
import { requireHydra, loadTail } from './store.ts'
import { privateDir, acquireLock, writeDurably, logPath } from '#store/storage.ts'
import { migrateColumns } from '#tasks/column-rules.ts'
import { declareTask } from '#tasks/declarations.ts'
import { agentActor } from '#hydra/hydra.ts'
import { isHelper, guardTaskLease } from '#routine-helper/leases.ts'
import { helperGrant } from '#routine-helper/route.ts'
import { labelsForEvent } from '#tasks/labels.ts'
import { randomInt } from 'node:crypto'
import { reduce } from './reducer.ts'
import { reconcileAsks } from '#tasks/questions.ts'
import { operationDeclarations, lifecycleMoves, lifecycleMoveId } from '#tasks/lifecycle.ts'
import { decideMove } from '#tasks/columns-decisions.ts'
import { writeSnapshot } from './snapshot.ts'

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

export function eventWriter({
  state: initial,
  dir,
  hydraId,
  transaction,
  onAppend,
}: {
  state: HydraState
  dir: string
  hydraId: string
  transaction?: string
  onAppend({ event }: { event: HydraEvent }): void
}): Writer {
  let state = initial
  const writer: Writer = {
    dir,
    get state() {
      return state
    },
    append({
      event,
      effects = true,
    }) {
      if (!agentActor({ actor: event.actor }) && (event.type !== 'hydra.message' || isHelper({ actor: event.actor }))) {
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
      const before = state
      state = reduce({
        state,
        event,
      })

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
    },
  }

  return writer
}
