import { background } from '#app/background.ts'
import { log } from '#app/diagnostics.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import type { CompactInput, Compaction, CompactionChange } from '#workers/compaction/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { reportActor } from '#hydra/hydra.ts'
import { hydraDeliveryId } from '#hydra/received.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { loadHydra } from '#app/store.ts'
import type { Host } from '#app/host-types.ts'
import type { Writer } from '#app/writer.ts'

// A deadline that could not record its failure tries again this soon.
const COMPACTION_RETRY_MS = 1000

// A running compaction with no status from its agent this long has failed. Claude Code repeats its status every 30 seconds; Codex sends none until the end, so this caps a Codex compaction.
export const COMPACTION_DEADLINE_MS = 10 * 60 * 1000

export interface CompactionHandoff {
  deadlines: {
    operation: Compaction
    remaining: number
  }[]
  settling?: number
}

// Inputs held while an agent compacts, the deadline that fails a silent compaction, and releasing them in order.
export function createCompactionControl({
  hydraId,
  compactionDelay,
  queuedHydra,
  closing,
  at,
  write,
  send,
  host,
  helperPending,
  statusChanged,
  released,
}: {
  hydraId: string
  compactionDelay: number
  queuedHydra: Set<string>
  closing(): boolean
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): Promise<T>
  send({
    card,
    text,
    original,
    actor,
    steering,
    direct,
    inputId,
  }: {
    card: string
    text: string
    original?: string
    actor: string
    steering?: string
    direct?: boolean
    inputId?: string
  }): unknown
  host(): Host
  helperPending(): boolean
  // A compaction's status changed; for Hydra's own it starts or ends the operation that stops Hydra.
  statusChanged({
    card,
    operation,
  }: {
    card: string
    operation: Compaction
  }): void
  // The card's compactions have settled: none runs, and none follows at once.
  released({ card }: { card: string }): void
}) {
  const compactionDeadlines = new Map<string, {
    timer: NodeJS.Timeout
    endsAt: number
  }>()

  const compactChange = async ({
    card,
    change,
  }: {
    card: string
    change: CompactionChange
  }) => {
    await write({
      fn: ({ writer }) => recordCompaction({
        writer,
        card,
        change,
        at: at(),
      }),
    })

    if (change.kind === 'status') {
      resetCompactionDeadline({ operation: change.operation })
      statusChanged({
        card,
        operation: change.operation,
      })
    }
  }

  // Each status of a running compaction restarts its deadline, so one that never reports a result still ends and releases what it held.
  const resetCompactionDeadline = ({
    operation,
    delay = compactionDelay,
  }: {
    operation: Compaction
    delay?: number
  }) => {
    clearTimeout(compactionDeadlines.get(operation.session)?.timer)
    compactionDeadlines.delete(operation.session)

    if (operation.state !== 'running') {
      return
    }

    compactionDeadlines.set(
      operation.session,
      {
        endsAt: Date.now() + delay,
        timer: setTimeout(
          () => background({
            name: 'compaction deadline',
            run: async () => {
              compactionDeadlines.delete(operation.session)

              if (closing()) {
                return
              }

              const { cards } = loadHydra({ hydraId }).state
              const card = Object.values(cards).find(candidate => candidate.compaction?.operations
                .some(known => known.id === operation.id && known.state === 'running'))

              if (!card) {
                return
              }

              await compactChange({
                card: card.id,
                change: {
                  kind: 'status',
                  operation: {
                    ...operation,
                    state: 'failed',
                    endedAt: at(),
                    error: 'The agent stopped reporting this compaction before it finished',
                  },
                },
              })
              releaseCompact({ card: card.id })
            },
            retry: () => resetCompactionDeadline({
              operation,
              delay: COMPACTION_RETRY_MS,
            }),
          }),
          delay,
        ).unref(),
      },
    )
  }

  const holdCompact = async ({
    card,
    input,
  }: {
    card: Card
    input: Omit<CompactInput, 'at'>
  }) => {
    if (!activeCompaction({ card })) {
      return false
    }

    await compactChange({
      card: card.id,
      change: {
        kind: 'held',
        input: {
          ...input,
          at: at(),
        },
      },
    })

    return true
  }

  const releasingCompact = new Set<string>()
  // After a result the agent may compact again at once, so held input waits until it moves on, or for one deadline.
  const settlingCompactions = new Map<string, {
    timer: NodeJS.Timeout
    endsAt: number
  }>()

  const compactionBusy = ({ card }: { card?: Card }) => Boolean(activeCompaction({ card }))
    || Boolean(card && settlingCompactions.has(card.id))

  const settleCompaction = ({
    card,
    settling,
    delay = compactionDelay,
  }: {
    card: string
    settling: boolean
    delay?: number
  }) => {
    const moved = settlingCompactions.has(card) && !settling
    clearTimeout(settlingCompactions.get(card)?.timer)
    settlingCompactions.delete(card)

    if (settling) {
      settlingCompactions.set(
        card,
        {
          endsAt: Date.now() + delay,
          timer: setTimeout(
            () => settleCompaction({
              card,
              settling: false,
            }),
            delay,
          ).unref(),
        },
      )
    } else if (moved) {
      releaseCompact({ card })
    }
  }

  const sessionOwner = ({
    state,
    session,
    fallback,
  }: {
    state: HydraState
    session: string
    fallback: string
  }) => state.cards[session === state.config?.hydra.session
    ? HYDRA_CARD : state.sessions?.[session]?.taskId ?? fallback]

  const syncCompactions = async ({ state }: { state: HydraState }) => {
    for (const card of Object.values(state.cards)) {
      for (const operation of card.compaction?.operations ?? []) {
        if (operation.state !== 'running') {
          continue
        }

        const destination = sessionOwner({
          state,
          session: operation.session,
          fallback: card.id,
        })
        const stays = card.agent && sessionId({ agent: card.agent }) === operation.session
          && (!destination || destination.id === card.id)

        if (stays) {
          continue
        }

        await compactChange({
          card: card.id,
          change: {
            kind: 'status',
            operation: {
              ...operation,
              state: 'failed',
              endedAt: at(),
              error: 'The agent session left this task during compaction',
            },
          },
        })

        if (destination?.agent && sessionId({ agent: destination.agent }) === operation.session) {
          await compactChange({
            card: destination.id,
            change: {
              kind: 'status',
              operation,
            },
          })
        }

        releaseCompact({ card: card.id })
      }
    }
  }

  const releaseCompact = ({ card: id }: { card: string }) => {
    if (closing() || releasingCompact.has(id)) {
      return
    }

    releasingCompact.add(id)
    let advanced = false
    setTimeout(
      () => {
        void (async () => {
          const card = loadHydra({ hydraId }).state.cards[id]

          if (!card || compactionBusy({ card })) {
            return
          }

          released({ card: id })
          const inputs = [...(card.compaction?.inputs ?? [])].sort((
            a,
            b,
          ) => Number(b.id === card.compaction?.priority)
            - Number(a.id === card.compaction?.priority))

          for (const input of inputs) {
            if (closing()) {
              return
            }

            if (compactionBusy({ card: loadHydra({ hydraId }).state.cards[id] })) {
              return
            }

            if (input.route === 'hydra') {
              await host().hydra({
                text: input.text,
                original: input.original,
                actor: input.actor,
                id: input.id,
                release: input.accepted,
                selected: input.agent,
              })

              while (!closing() && queuedHydra.has(input.id)) {
                await new Promise(resolve => setTimeout(
                  resolve,
                  20,
                ))
              }

              const state = loadHydra({ hydraId }).state
              const message = state.hydraMessages?.find(message => message.id === input.id)
              const marker = hydraDeliveryId({
                message: message ?? { id: input.id },
                release: input.accepted,
              })
              const settled = message?.stopped || message?.failure
              const noOp = reportActor({ actor: input.actor })
                || (input.id.startsWith('helper-outcomes:') && !helperPending()) || settled

              if (closing() || (!noOp && !(marker in state.eventIds))) {
                return
              }
            } else {
              await send({
                card: id,
                text: input.text,
                original: input.original,
                actor: input.actor,
                ...(input.route === 'steering' ? { steering: input.id } : {
                  direct: true,
                  inputId: input.id,
                }),
              })

              if (input.route === 'direct') {
                while (!closing() && loadHydra({ hydraId }).state.cards[id]?.compaction?.inputs
                  .some(queued => queued.id === input.id)) {
                  await new Promise(resolve => setTimeout(
                    resolve,
                    20,
                  ))
                }

                if (closing()) {
                  return
                }
              }
            }

            if (input.route !== 'direct') {
              await compactChange({
                card: id,
                change: {
                  kind: 'taken',
                  id: input.id,
                },
              })
            }

            advanced = true
          }
        })().catch((error: Error) => log({
          level: 'error',
          operation: 'compact.queue',
          hydraId,
          taskId: id,
          error,
        }))
          .finally(() => {
            releasingCompact.delete(id)

            if (closing()) {
              return
            }

            const current = loadHydra({ hydraId }).state.cards[id]

            if (advanced && current?.compaction?.inputs.length
              && !compactionBusy({ card: current })) {
              releaseCompact({ card: id })
            }
          })
      },
      0,
    ).unref()
  }

  return {
    compactChange,
    holdCompact,
    releaseCompact,
    sessionOwner,
    settleCompaction,
    settling: settlingCompactions,
    syncCompactions,
    suspendTask({ card }: { card: Card }): CompactionHandoff {
      const deadlines: CompactionHandoff['deadlines'] = []

      for (const operation of card.compaction?.operations ?? []) {
        const deadline = compactionDeadlines.get(operation.session)

        if (deadline) {
          deadlines.push({
            operation,
            remaining: Math.max(
              0,
              deadline.endsAt - Date.now(),
            ),
          })
          clearTimeout(compactionDeadlines.get(operation.session)?.timer)
          compactionDeadlines.delete(operation.session)
        }
      }

      const deadline = settlingCompactions.get(card.id)
      clearTimeout(settlingCompactions.get(card.id)?.timer)
      settlingCompactions.delete(card.id)

      return {
        deadlines,
        settling: deadline === undefined ? undefined : Math.max(
          0,
          deadline.endsAt - Date.now(),
        ),
      }
    },
    adoptTask({
      card,
      handoff,
    }: {
      card: Card
      handoff: CompactionHandoff
    }): void {
      for (const {
        operation,
        remaining,
      } of handoff.deadlines) {
        resetCompactionDeadline({
          operation,
          delay: remaining,
        })
      }

      if (handoff.settling !== undefined) {
        settleCompaction({
          card: card.id,
          settling: true,
          delay: handoff.settling,
        })
      }

      releaseCompact({ card: card.id })
    },
    close() {
      for (const timer of [
        ...compactionDeadlines.values(),
        ...settlingCompactions.values(),
      ]) {
        clearTimeout(timer.timer)
      }
    },
  }
}
