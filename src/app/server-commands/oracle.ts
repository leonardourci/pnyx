import type { createIndexSync } from '#oracle/index-sync.ts'
import { search as oracleSearch } from '#oracle/search.ts'
import { indexedThrough } from '#oracle/status.ts'
import { HydraError } from '#store/errors.ts'
import type { HydraState } from '#app/model.ts'
import type { CommandRequest } from './dispatch.ts'

const ORACLE_LIMIT = 100

// `oracle <text> [<workspace>] [hydra]`: searches the history once the index has caught up.
export function oracleCommand({
  ws,
  id,
  args,
  fail,
  send,
  hydraId,
  state,
  historyIndex,
}: CommandRequest & {
  hydraId: string
  state(): HydraState
  historyIndex: ReturnType<typeof createIndexSync>
}) {
  if (args.length > 3 || (args[2] !== undefined && args[2] !== 'hydra')) {
    throw new HydraError({
      message: 'oracle expects text, optional workspace and optional Hydra scope',
      code: 'VALIDATION_ERROR',
    })
  }

  const query = {
    text: args[0] ?? '',
    ...(args[1] ? { workspace: args[1] } : {}),
    ...(args[2] === 'hydra' ? { live: true } : {}),
    limit: ORACLE_LIMIT,
    highlight: false,
  }

  // Never rejects, so nothing is lost by not awaiting it.
  const answer = async () => {
    try {
      const indexed = indexedThrough({ hydraId })
      const behind = indexed === null || indexed < state().seq

      if (behind) {
        const failure = await historyIndex.ready()

        if (failure) {
          return fail({
            error: `Oracle index could not catch up: ${failure.message}`,
            code: failure.code,
          })
        }
      } else {
        historyIndex.changed()
      }

      send({
        ws,
        message: {
          type: 'receipt',
          id,
          ...oracleSearch({
            hydraId,
            query,
          }),
        },
      })
    } catch (error) {
      fail({
        error: (error as Error).message,
        code: error instanceof HydraError ? error.code : 'UNKNOWN',
      })
    }
  }

  answer()
}
