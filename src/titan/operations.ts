import { assignDefined } from '#workers/session-attachments.ts'
import type { Decision, TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraEvent, othrysRunsTitan } from './titan.ts'
import { TITAN_CARD } from './identity.ts'
import { isRoutineMessage, type TitanOperation } from './model.ts'
import { outageMinutes, recapText } from './wakes.ts'
import { operationLabel } from './operation-label.ts'
import { TITAN_ACTOR } from '#app/actors.ts'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import type { Host } from '#app/host-types.ts'
import { loadTitan } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'
import { ownerActor } from '#app/actors.ts'
import { TitanError } from '#store/errors.ts'
import { failTitanInput, hydraDeliveryId, hydraInputDispatched } from './received.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import type { AgentRef } from '#workers/model.ts'

export function operationEvent({
  state,
  operation,
  meta,
  eventId,
}: {
  state: TitanState
  operation: TitanOperation
  meta: Meta
  eventId?: string
}): Decision {
  const data: TitanOperation = {
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
    cardId: TITAN_CARD,
    meta: {
      ...meta,
      id: eventId ?? `operation:${operation.id}:${operation.state}`,
    },
    change: {
      type: 'hydra.operation',
      data,
    },
  })
}

// Input whose turn already started does not need another turn when a clean stop ends.
const arrivedSince = ({
  state,
  after,
}: {
  state: TitanState
  after: number
}) => (state.hydraMessages ?? []).some(message => (state.eventIds[message.id] ?? 0) > after
  && !hydraInputDispatched({
    state,
    message,
  }) && !message.stopped && !message.failure
  && message.actor !== TITAN_ACTOR && message.kind !== 'divider'
  && !isRoutineMessage({ message }))

// Titan's first turn after an operation stopped it: what it was, how it ended and what the owner wrote meanwhile.
function operationRecap({
  state,
  operation,
  error,
  now,
}: {
  state: TitanState
  operation: NonNullable<TitanState['hydraOperation']>
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

export function createTitanOperations({
  hydraId,
  queuedTitan,
  at,
  note,
  armWake,
  host,
}: {
  hydraId: string
  queuedTitan: Set<string>
  at(): string
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): Promise<void>
  armWake(): void
  host(): Pick<Host, 'hydra'>
}) {
  // One machinery for whatever stops Titan for a while: it records the start and the end, holds nothing of its own,
  // and when it ends Titan's first turn is the recap of what arrived meanwhile.
  // The first of back-to-back operations: the recap after the last one covers everything since it began.
  let stoppedSince: NonNullable<TitanState['hydraOperation']> | undefined
  let recapId: string | undefined
  // The owner's Stop ended the running stop and cancelled what waited behind it, so no recap follows.
  let stoppedByOwner = false

  const stoppedFor = ({ id }: { id: string }) => {
    if (id.startsWith('operation:') && recapId && id !== recapId) {
      return true
    }

    return Boolean(loadTitan({ hydraId }).state.hydraOperation)
  }

  const startOperation = ({
    id,
    kind,
  }: {
    id: string
    kind: TitanOperation['kind']
  }) => note({
    fn: ({ writer }) => {
      // A second compaction straight after the first, or a restart inside an upgrade, continues the same stop.
      if (writer.state.hydraOperation) {
        return
      }

      if (recapId && Object.hasOwn(
        writer.state.eventIds,
        hydraDeliveryId({ message: { id: recapId } }),
      )) {
        stoppedSince = undefined
      }

      recapId = `operation:${id}`

      // Messages already waiting for a Titan turn when the stop begins are part of what it recaps.
      const waiting = [...queuedTitan].flatMap(queuedId => writer.state.eventIds[queuedId] ?? [])
      const operation: TitanOperation = {
        id,
        kind,
        state: 'started',
        through: writer.state.seq,
      }

      if (waiting.length) {
        operation.after = Math.min(...waiting.map(seq => seq - 1))
      }

      if (!stoppedSince) {
        stoppedByOwner = false
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
    const state = loadTitan({ hydraId }).state
    const running = state.hydraOperation?.id === id ? state.hydraOperation : undefined

    if (!running) {
      return
    }

    const ended: TitanOperation = {
      id,
      kind: running.kind,
      state: error ? 'failed' : 'finished',
    }

    if (error) {
      ended.error = error
    }

    const recap = () => background({
      name: 'Titan back after a stop',
      run: async () => {
        const state = loadTitan({ hydraId }).state

        // Another operation started meanwhile; the recap waits for the last one to end.
        if (state.hydraOperation) {
          return
        }

        const since = stoppedSince ?? running

        // Titan waits for the owner's next message instead of a recap; a Stop from before the operation leaves what waited to deliver.
        if (stoppedByOwner) {
          stoppedByOwner = false
          stoppedSince = undefined

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
          const recap = operationRecap({
            state,
            operation: since,
            error,
            now: Date.now(),
          })
          recapId = `operation:${id}`
          await host().hydra({
            id: recapId,
            actor: 'pnyx',
            ...recap,
          })
        } else {
          stoppedSince = undefined
        }

        armWake()
      },
    })

    note({
      fn: ({ writer }) => {
        applyDecision({
          writer,
          decision: operationEvent({
            state: writer.state,
            operation: ended,
            meta: {
              at: at(),
              actor: 'pnyx',
            },
          }),
        })
        writer.afterCommit({ run: recap })
      },
    })
  }

  return {
    stoppedFor,
    startOperation,
    endOperation,
    stoppedByOwner: () => {
      stoppedByOwner = true
      stoppedSince = undefined
    },
  }
}

export function createTitanOutage({
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
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): Promise<T>
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
  let outage: NonNullable<TitanState['hydraStatus']> | undefined

  // One recap per outage: its id names the down event, so a retried or repeated recap starts at most one turn.
  const recapTurn = ({ down }: { down: NonNullable<TitanState['hydraStatus']> }) => background({
    name: 'Titan recap',
    retry: planRetry,
    run: () => host().hydra({
      id: `back:${down.seq}`,
      actor: 'pnyx',
      ...recapText({
        state: loadTitan({ hydraId }).state,
        since: down.since,
        after: down.after ?? down.seq,
        now: Date.now(),
      }),
    }),
  })

  // A start worked after Titan was down: say so in Othrys's voice, then give Titan the recap once the turn that started it ends.
  const back = async ({
    down,
    turn,
    hydra,
  }: {
    down: NonNullable<TitanState['hydraStatus']>
    turn: string
    hydra: string
  }) => {
    clearTimeout(retryTimer)
    retryTimer = undefined
    retries = 0
    const now = Date.now()
    await write({
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
            cardId: TITAN_CARD,
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
            cardId: TITAN_CARD,
            change: {
              type: 'hydra.message',
              data: {
                action: 'send',
                hydra,
                text: `Titan is back after ${outageMinutes({
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

  // The recap turn tries the start again; a Titan that is up, or no longer Othrys's to run, needs no retry.
  const retryStart = () => {
    retryTimer = undefined
    const state = loadTitan({ hydraId }).state
    const status = state.hydraStatus

    if (closing() || status?.state !== 'down' || !othrysRunsTitan({ state })) {
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
        name: 'Titan retry',
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
      state: loadTitan({ hydraId }).state,
      since: outage.since,
      after: outage.after ?? outage.seq,
      now: Date.now(),
    }) : undefined

    if (recap) {
      outage = undefined
    }

    return recap
  }

  // A start that failed: Titan's turn is finished, and a start Othrys may retry marks Titan down and plans the retry.
  const startFailed = async ({
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
    // An outside agent is not Othrys's to start, so it is refused once rather than retried.
    const retried = !(error instanceof TitanError && error.code === 'NO_ROUTE')
    const detail = retried
      ? `Titan could not start: ${reason}. Othrys is retrying; check the harness login and settings if this lasts.`
      : `Titan could not start: ${reason}`
    // Finished rather than interrupted, so a retry or the next wake starts Titan again; a cut turn's attention still waits for the owner.
    await write({
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
            key: TITAN_CARD,
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
              cardId: TITAN_CARD,
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
        if (ownerActor({ actor })) {
          failTitanInput({
            writer,
            input: id,
            error: reason,
            at: now,
          })
        } else if (!down) {
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: {
                at: now,
                actor: 'pnyx',
              },
              cardId: TITAN_CARD,
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
