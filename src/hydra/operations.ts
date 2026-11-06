import { assignDefined } from '#workers/session-attachments.ts'
import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraOperation } from './model.ts'
import { outageMinutes, recapText } from './wakes.ts'
import { operationLabel } from './operation-label.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import type { Host } from '#app/host-types.ts'
import { loadHydra } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'

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

// Whether anything addressed to Hydra was recorded since the stop began.
export const arrivedSince = ({
  state,
  after,
}: {
  state: HydraState
  after: number
}) => (state.hydraMessages ?? []).some(message => (state.eventIds[message.id] ?? 0) > after
  && message.actor !== HYDRA_ACTOR && message.kind !== 'progress' && message.kind !== 'divider')

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
}): string {
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
    whole: true,
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
            ? `<pnyx-wake>Compaction failed: ${error}. The agent switch is still waiting for the owner to retry; its queued messages remain held.</pnyx-wake>`
            : operationRecap({
              state,
              operation: since,
              error,
              now: Date.now(),
            })
          await host().hydra({
            id: `operation:${id}`,
            actor: 'pnyx',
            text: recap,
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
