import { recordContext } from './file-context.ts'
import { readChanges } from '#app/event-log.ts'
import { randomUUID } from 'node:crypto'
import { meta, commit, integer, type Output } from '#app/cli-support.ts'
import { loadTitan } from '#app/store.ts'
import { TITAN_CARD } from './identity.ts'
import { inscribeOperation } from './history.ts'
import { operationEvent } from './operations.ts'

export async function hydraInscribe({
  values,
  positionals,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
  hydraId: string
}): Promise<Output> {
  const action = positionals[1]
  const state = loadTitan({ hydraId }).state
  const m = meta({ values })
  const savedSeq = m.id ? state.eventIds[m.id] : undefined
  const saved = savedSeq === undefined ? undefined : readChanges({
    hydraId,
    ids: [m.id!],
  })[0]
  const savedOperation = saved?.type === 'hydra.operation' && saved.data.kind === 'inscribe' ? saved.data.id : undefined
  const running = state.historyMilestones?.findLast(item => item.kind === 'inscribe' && item.state === 'started')
  const requestedId = values.key === undefined ? running?.id ?? randomUUID() : String(values.key)
  const operationId = savedOperation ?? requestedId
  const through = integer({
    value: values.through,
    flag: '--through',
  })
  const error = values.error as string | undefined

  const operationState = action === 'finish' ? 'finished' : action === 'fail' ? 'failed' : 'started'
  const eventMeta = {
    ...m,
    id: m.id ?? `operation:${operationId}:${operationState}`,
  }
  const result = await commit({
    hydraId,
    meta: eventMeta,
    intent: {
      type: 'hydra.operation',
      card: TITAN_CARD,
    },
    decide: ({ state }) => operationEvent({
      state,
      meta: eventMeta,
      eventId: eventMeta.id,
      operation: inscribeOperation({
        state,
        id: operationId,
        action,
        through,
        error,
      }),
    }),
  })
  const updated = loadTitan({ hydraId }).state
  const operation = updated.historyMilestones?.find(item => item.id === operationId)

  if (!operation) {
    throw new Error('Inscribe milestone was not recorded')
  }

  return {
    ...result,
    milestone: operationId,
    through: operation.through,
    records: recordContext({ hydraId }),
  }
}
