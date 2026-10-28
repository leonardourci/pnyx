import type { HydraState, HydraEvent } from './model.ts'
import { HydraError } from '../store/errors.ts'
import { LABEL_COLORS } from '../tasks/model.ts'
import { hydraDir } from './home-migration.ts'
import { requireHydra, loadTail } from './store.ts'
import { privateDir, acquireLock, writeDurably, logPath } from '../store/storage.ts'
import { migrateColumns } from '../tasks/column-rules.ts'
import { declareTask } from '../tasks/declarations.ts'
import { agentActor } from '../core/hydra.ts'
import { isHelper, guardTaskLease } from '../helper/leases.ts'
import { helperGrant } from '../helper/route.ts'
import { labelsForEvent } from '../tasks/labels.ts'
import { randomInt } from 'node:crypto'
import { reduce } from './reducer.ts'
import { reconcileAsks } from '../tasks/questions.ts'
import { operationDeclarations, lifecycleMoves, lifecycleMoveId } from '../tasks/lifecycle.ts'
import { decideMove } from '../tasks/columns-decisions.ts'
import { writeSnapshot } from './snapshot.ts'

export interface Writer {
  readonly state: HydraState
  readonly dir: string
  append({ event }: { event: HydraEvent }): void
}

// Runs `fn` as the Hydra's single writer. Each append is flushed to disk before
// the state advances; the snapshot is replaced afterwards.
export function withWriter<T>({
  hydraId,
  fn,
  create = false,
  lockTimeout,
}: {
  hydraId: string
  // Only `hydra create` makes a new Hydra; the default Hydra is made on first use.
  create?: boolean
  lockTimeout?: number
  fn: (
    { writer }: {
      writer: Writer
    },
  ) => T
}): T {
  const dir = hydraDir({ hydraId })

  if (!create) {
    requireHydra({ hydraId })
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
    } = loadTail({ hydraId })
    let dirty = false

    try {
      const writer: Writer = {
        dir,
        get state() {
          return state
        },
        append({ event }) {
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

          if (labelColors.length) {
            event = {
              ...event,
              labelColors,
            }
          }

          const card = state.cards[event.cardId]
          const parent = event.type === 'task.created' ? event.data.parentId : card?.parentId
          const session = event.type === 'task.session' ? event.data.session : card?.sessionIds?.[0]
          const agent = event.type === 'card.pushed' && event.data.agent
            ? event.data.agent : session ? state.sessions?.[session]?.agent : card?.agent
          const observedSession = agent
            ? `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}` : session
          event = {
            boardId: hydraId,
            ...(event.cardId !== '$board' ? { taskId: parent ?? event.cardId } : {}),
            ...(parent ? { subtaskId: event.cardId } : {}),
            ...(agent ? { agentId: `${agent.provider}:${agent.agentId ?? agent.sessionId}` } : {}),
            ...(observedSession ? { sessionId: observedSession } : {}),
            commandId: event.id,
            ...(event.type === 'card.replied' ? { messageId: event.data.reply } : {}),
            ...event,
          }
          const line = `${JSON.stringify(event)}\n`
          writeDurably({
            path: logPath({ dir }),
            data: line,
            flag: 'a',
          })
          offset += Buffer.byteLength(line)
          const before = state
          state = reduce({
            state,
            event,
          })
          dirty = true

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
      // A Hydra still on an older layout moves onto the default columns before its next write.
      const migrated = migrateColumns({
        state,
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      })

      if ('event' in migrated) {
        writer.append({ event: migrated.event })
      }

      return fn({ writer })
    } finally {
      if (dirty) {
        writeSnapshot({
          dir,
          state,
          offset,
        })
      }
    }
  } finally {
    release()
  }
}
