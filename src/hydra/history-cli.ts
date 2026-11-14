import { randomUUID } from 'node:crypto'
import { meta, commit, integer, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from './identity.ts'
import {
  historyCommand,
  historyMessages,
  historyRange,
  historyTokens,
  inscribeOperation,
  readHistory,
  type HistoryWindow,
} from './history.ts'
import { messageWindow } from './message-window.ts'
import { nativeSources } from './native-window.ts'
import { operationEvent } from './operations.ts'

const HISTORY_TYPES = [
  'hydra.message',
  'hydra.helper-finished',
  'task.created',
  'task.brief',
  'task.owner-ask',
  'task.intent',
]

export function hydraHistoryWindow({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): HistoryWindow {
  const sources = nativeSources({
    state,
    card: HYDRA_CARD,
  })

  return ({
    lo,
    hi,
  }) => {
    const {
      events,
      native,
      positions,
    } = messageWindow({
      hydraId,
      sources,
      types: HISTORY_TYPES,
      lo,
      hi,
    })

    return historyMessages({
      positions,
      events,
      native: native.filter(entry => entry.kind === 'message' && entry.role.startsWith('assistant')),
    })
  }
}

export function hydraHistoryPage({
  hydraId,
  since,
  after,
  through,
  budget,
}: {
  hydraId: string
  since: string
  after?: string
  through?: number
  budget?: number
}) {
  const state = loadHydra({ hydraId }).state

  return readHistory({
    window: hydraHistoryWindow({
      hydraId,
      state,
    }),
    state,
    since,
    after,
    through,
    budget,
  })
}

export function hydraHistoryTokens({
  hydraId,
  since,
  limit,
}: {
  hydraId: string
  since: string
  limit?: number
}): number {
  const state = loadHydra({ hydraId }).state
  const range = historyRange({
    state,
    since,
  })

  return historyTokens({
    window: hydraHistoryWindow({
      hydraId,
      state,
    }),
    boundary: range.boundary,
    through: range.through,
    limit,
  })
}

export function hydraHistory({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Output {
  const request = {
    hydraId,
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
  }

  if (values.count) {
    const state = loadHydra({ hydraId }).state
    const range = historyRange({
      state,
      since: request.since,
      after: request.after,
      through: request.through,
    })

    return {
      totalTokens: historyTokens({
        window: hydraHistoryWindow({
          hydraId,
          state,
        }),
        boundary: range.boundary,
        through: range.through,
      }),
      boundary: range.boundary,
      snapshot: range.through,
    }
  }

  const page = hydraHistoryPage(request)

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
