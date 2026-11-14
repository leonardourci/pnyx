import { assignDefined } from '#workers/session-attachments.ts'
import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraEvent, pnyxRunsHydra } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import { isRoutineMessage, type HydraOperation } from './model.ts'
import { outageMinutes, recapText } from './wakes.ts'
import { operationLabel } from './operation-label.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import type { Host } from '#app/host-types.ts'
import { loadHydra } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'
import { ownerActor } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import type { AgentRef } from '#workers/model.ts'

export { operationLabel } from './operation-label.ts'

export function operationEvent({
  state,
  operation,
  meta,
}: {
  state: HydraState
  operation: HydraOperation
  meta: Meta
}): Decision {
  const data: HydraOperation = {
    id: operation.id,
    kind: operation.kind,
    state: operation.state,
  }
  assignDefined({
    target: data,
    values: {
      error: operation.error,
      after: operation.after,
      through: operation.through,
      historySince: operation.historySince,
      parent: operation.parent,
      blocking: operation.blocking,
    },
  })

  return hydraEvent({
    state,
    cardId: HYDRA_CARD,
    meta: {
      ...meta,
      id: `operation:${operation.id}:${operation.state}`,
    },
    change: {
      type: 'hydra.operation',
      data,
    },
  })
}

// Input whose turn already started does not need another turn when a clean stop ends.
export const arrivedSince = ({
  state,
  after,
}: {
  state: HydraState
  after: number
}) => (state.hydraMessages ?? []).some(message => (state.eventIds[message.id] ?? 0) > after
  && !(`${message.id}:hosted` in state.eventIds) && !message.stopped
  && message.actor !== HYDRA_ACTOR && message.kind !== 'progress' && message.kind !== 'divider'
  && !isRoutineMessage({ message }))

// Hydra's first turn after an operation stopped it: what it was, how it ended and what the owner wrote meanwhile.
export function operationRecap({
  state,
  operation,
  error,
  now,
}: {
  state: HydraState
  operation: NonNullable<HydraState['hydraOperation']>
  error?: string
  now: number
}): ReturnType<typeof recapText> {
  const minutes = outageMinutes({
    since: operation.since,
    now,
  })
  const label = operationLabel({
    kind: operation.kind,
    state: error ? 'failed' : 'finished',
  })

  return recapText({
    state,
    since: operation.since,
    after: operation.seq,
    now,
    why: `Why you are woken: back after a stop (${label}${error ? `: ${error}` : ''}). Everything addressed to you waited from ${operation.since} until now (${minutes} min).`,
  })
}

export function createHydraOperations({
  hydraId,
  queuedHydra,
  at,
  note,
  armWake,
  host,
}: {
  hydraId: string
  queuedHydra: Set<string>
  at(): string
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  armWake(): void
  host(): Host
}) {
  // One machinery for whatever stops Hydra for a while: it records the start and the end, holds nothing of its own,
  // and when it ends Hydra's first turn is the recap of what arrived meanwhile.
  // The first of back-to-back operations: the recap after the last one covers everything since it began.
  let stoppedSince: NonNullable<HydraState['hydraOperation']> | undefined

  const stoppedFor = ({ id }: { id: string }) => {
    const running = loadHydra({ hydraId }).state.hydraOperation

    const change = loadHydra({ hydraId }).state.hydraAgentChange

    return (Boolean(running) || Boolean(change)) && !id.startsWith('operation:')
  }

  const startOperation = ({
    id,
    kind,
    after,
    independent = false,
  }: {
    id: string
    after?: number
    kind: HydraOperation['kind']
    independent?: boolean
  }) => note({
    fn: ({ writer }) => {
      // A second compaction straight after the first, or a restart inside an upgrade, continues the same stop.
      if (writer.state.hydraOperation && !independent) {
        return
      }

      // Messages already waiting for a Hydra turn when the stop begins are part of what it recaps.
      const waiting = [...queuedHydra].flatMap(queuedId => writer.state.eventIds[queuedId] ?? [])
      const operation: HydraOperation = {
        id,
        kind,
        state: 'started',
        through: writer.state.seq,
      }

      if (writer.state.hydraOperation) {
        operation.blocking = false
      }

      if (waiting.length || after !== undefined) {
        operation.after = Math.min(
          after ?? Infinity,
          ...waiting.map(seq => seq - 1),
        )
      }

      if (!stoppedSince) {
        stoppedSince = {
          id,
          kind,
          since: at(),
          seq: operation.after ?? writer.state.seq + 1,
        }
      }

      applyDecision({
        writer,
        decision: operationEvent({
          state: writer.state,
          operation,
          meta: {
            at: at(),
            actor: 'pnyx',
          },
        }),
      })
    },
  })

  const endOperation = ({
    id,
    error,
  }: {
    id: string
    error?: string
  }) => {
    const state = loadHydra({ hydraId }).state
    const active = state.hydraOperation
    const running = active?.id === id ? active : undefined
    const milestone = state.historyMilestones?.find(item => item.id === id)

    if (!running && (milestone?.state !== 'started' || milestone.blocking !== false)) {
      return
    }

    const kind = running?.kind ?? milestone?.kind

    if (!kind) {
      return
    }

    const ended: HydraOperation = {
      id,
      kind,
      state: error ? 'failed' : 'finished',
    }

    if (!running) {
      ended.blocking = false
    }

    if (error) {
      ended.error = error
    }

    note({
      fn: ({ writer }) => applyDecision({
        writer,
        decision: operationEvent({
          state: writer.state,
          operation: ended,
          meta: {
            at: at(),
            actor: 'pnyx',
          },
        }),
      }),
    })
    background({
      name: 'Hydra back after a stop',
      run: async () => {
        const state = loadHydra({ hydraId }).state

        // Another operation started meanwhile; the recap waits for the last one to end.
        if (state.hydraOperation || state.hydraAgentChange?.state === 'running') {
          return
        }

        const since = stoppedSince ?? running
        stoppedSince = undefined
        const hydraCard = state.cards[HYDRA_CARD]

        // The owner's Stop ended it: Hydra waits for their next message instead of a recap.
        if ((hydraCard?.sessionActivity ?? hydraCard?.activity) === 'interrupted') {
          return
        }

        if (!since) {
          armWake()

          return
        }

        // A clean stop that nothing waited on needs no turn of its own.
        if (error || arrivedSince({
          state,
          after: since.seq,
        })) {
          const pendingSwitch = state.hydraAgentChange
          const recap = error && pendingSwitch
            ? {
              text: `<pnyx-wake>Compaction failed: ${error}. The agent switch is still waiting for the owner to retry; its queued messages remain held.</pnyx-wake>`,
              carried: [],
            }
            : operationRecap({
              state,
              operation: since,
              error,
              now: Date.now(),
            })
          await host().hydra({
            id: `operation:${id}`,
            actor: 'pnyx',
            ...recap,
          })
        }

        armWake()
      },
    })
  }

  return {
    stoppedFor,
    startOperation,
    endOperation,
  }
}

export function createHydraOutage({
  hydraId,
  retryDelays,
  closing,
  at,
  write,
  record,
  host,
}: {
  hydraId: string
  retryDelays: number[]
  closing(): boolean
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  record({
    writer,
    agent,
    input,
    actor,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
  }): void
  host(): Host
}) {
  // Retries a failed start on a growing wait; each failed try plans the next one.
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retries = 0

  // The outage a queued recap turn reports; its text is built when the turn starts, so it leaves out messages answered first.
  let outage: NonNullable<HydraState['hydraStatus']> | undefined

  // One recap per outage: its id names the down event, so a retried or repeated recap starts at most one turn.
  const recapTurn = ({ down }: { down: NonNullable<HydraState['hydraStatus']> }) => background({
    name: 'Hydra recap',
    retry: planRetry,
    run: () => host().hydra({
      id: `back:${down.seq}`,
      actor: 'pnyx',
      ...recapText({
        state: loadHydra({ hydraId }).state,
        since: down.since,
        after: down.after ?? down.seq,
        now: Date.now(),
      }),
    }),
  })

  // A start worked after Hydra was down: say so in Pnyx's voice, then give Hydra the recap once the turn that started it ends.
  const back = ({
    down,
    turn,
    hydra,
  }: {
    down: NonNullable<HydraState['hydraStatus']>
    turn: string
    hydra: string
  }) => {
    clearTimeout(retryTimer)
    retryTimer = undefined
    retries = 0
    const now = Date.now()
    write({
      fn: ({ writer }) => {
        const meta = {
          at: new Date(now).toISOString(),
          actor: 'pnyx',
        }
        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.status',
              data: {
                state: 'up',
                since: meta.at,
              },
            },
          }),
        })
        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.message',
              data: {
                action: 'send',
                hydra,
                text: `Hydra is back after ${outageMinutes({
                  since: down.since,
                  now,
                })} min.`,
              },
            },
          }),
        })
      },
    })

    outage = down

    if (turn !== `back:${down.seq}`) {
      recapTurn({ down })
    }
  }

  // The recap turn tries the start again; a Hydra that is up, or no longer Pnyx's to run, needs no retry.
  const retryStart = () => {
    retryTimer = undefined
    const state = loadHydra({ hydraId }).state
    const status = state.hydraStatus

    if (closing() || status?.state !== 'down' || !pnyxRunsHydra({ state })) {
      return
    }

    recapTurn({ down: status })
  }

  const planRetry = () => {
    if (retryTimer || closing()) {
      return
    }

    retryTimer = setTimeout(
      () => background({
        name: 'Hydra retry',
        run: retryStart,
        retry: planRetry,
      }),
      retryDelays[Math.min(
        retries,
        retryDelays.length - 1,
      )],
    )
    retries += 1
  }

  const takeRecap = ({ id }: { id: string }) => {
    const recap = outage && id === `back:${outage.seq}` ? recapText({
      state: loadHydra({ hydraId }).state,
      since: outage.since,
      after: outage.after ?? outage.seq,
      now: Date.now(),
    }) : undefined

    if (recap) {
      outage = undefined
    }

    return recap
  }

  // A start that failed: Hydra's turn is finished, and a start Pnyx may retry marks Hydra down and plans the retry.
  const startFailed = ({
    error,
    previous,
    id,
    actor,
    hydra,
  }: {
    error: unknown
    previous?: Card
    id: string
    actor: string
    hydra: string
  }) => {
    const reason = (error as Error).message
    // An outside agent is not Pnyx's to start, so it is refused once rather than retried.
    const retried = !(error instanceof HydraError && error.code === 'NO_ROUTE')
    const detail = retried
      ? `Hydra could not start: ${reason}. Pnyx is retrying; check the harness login and settings if this lasts.`
      : `Hydra could not start: ${reason}`
    // Finished rather than interrupted, so a retry or the next wake starts Hydra again; a cut turn's attention still waits for the owner.
    write({
      fn: ({ writer }) => {
        const down = writer.state.hydraStatus?.state === 'down'
        const now = at()

        if (previous?.agent?.host === 'pnyx') {
          record({
            writer,
            agent: previous.agent,
            input: { activity: 'finished' },
            actor: 'pnyx',
          })
        }

        applyDecision({
          writer,
          decision: decidePush({
            state: writer.state,
            key: HYDRA_CARD,
            input: { activity: 'finished' },
            meta: {
              at: now,
              actor: 'pnyx',
            },
          }),
        })

        if (retried && !down) {
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: {
                at: now,
                actor: 'pnyx',
              },
              cardId: HYDRA_CARD,
              change: {
                type: 'hydra.status',
                data: {
                  state: 'down',
                  since: now,
                  detail: reason,
                  after: Math.min(
                    writer.state.seq,
                    (writer.state.eventIds[id] ?? Infinity) - 1,
                  ),
                },
              },
            }),
          })
        }

        // Retries fail quietly; the owner hears of each failure their own message meets.
        if (!down || ownerActor({ actor })) {
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: {
                at: now,
                actor: 'pnyx',
              },
              cardId: HYDRA_CARD,
              change: {
                type: 'hydra.message',
                data: {
                  action: 'send',
                  hydra,
                  text: detail,
                },
              },
            }),
          })
        }
      },
    })

    if (retried) {
      planRetry()
    }

    return {
      state: 'failed',
      detail,
    }
  }

  return {
    back,
    takeRecap,
    startFailed,
    planRetry,
    close: () => clearTimeout(retryTimer),
  }
}
