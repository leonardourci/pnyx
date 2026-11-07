import { randomUUID } from 'node:crypto'
import { meta, commit, integer, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { HYDRA_CARD } from './identity.ts'
import { historyCommand, inscribeOperation, readHistory } from './history.ts'
import { operationEvent } from './operations.ts'

export function harvestHydra({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): void {
  withWriter({
    hydraId,
    fn: ({ writer }) => harvestTranscripts({
      writer,
      cardIds: [HYDRA_CARD],
      at: meta({ values }).at,
    }),
  })
}

export function hydraHistory({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Output {
  const state = loadHydra({ hydraId }).state
  const page = readHistory({
    state,
    events: readEvents({ hydraId }),
    since: String(values.since ?? (values.inscribe ? 'last-inscribe' : 'last-compaction')),
    after: values.after as string | undefined,
    through: integer({
      value: values.through,
      flag: '--through',
    }),
    budget: integer({
      value: values.budget,
      flag: '--budget',
    }),
  })

  if (values.count) {
    return {
      totalTokens: page.totalTokens,
      boundary: page.boundary,
      snapshot: page.snapshot,
    }
  }

  return {
    ...page,
    help: page.more ? [
      `Run \`${historyCommand({
        hydraId,
        since: page.since,
        budget: page.budget,
      })} --after ${page.after}\` for the next page`,
    ] : [],
  }
}

export function hydraInscribe({
  values,
  positionals,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
  hydraId: string
}): Output {
  const action = positionals[1]
  const state = loadHydra({ hydraId }).state
  const running = state.historyMilestones?.findLast(item => item.kind === 'inscribe' && item.state === 'started')
  const operationId = values.key === undefined ? running?.id ?? randomUUID() : String(values.key)
  const through = integer({
    value: values.through,
    flag: '--through',
  })
  const error = values.error as string | undefined
  const operation = inscribeOperation({
    state,
    id: operationId,
    action,
    through,
    error,
  })

  const m = meta({ values })
  const result = commit({
    hydraId,
    meta: m,
    intent: {
      type: 'hydra.operation',
      card: HYDRA_CARD,
    },
    decide: ({ state }) => operationEvent({
      state,
      meta: m,
      operation: inscribeOperation({
        state,
        id: operationId,
        action,
        through,
        error,
      }),
    }),
  })
  const since = operation.historySince ?? 'origin'

  return {
    ...result,
    milestone: operationId,
    through: operation.through,
    command: historyCommand({
      hydraId,
      since,
      through: operation.through,
    }),
  }
}
