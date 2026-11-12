import { readSearchFilters } from '#oracle/filters.ts'
import { searchInBackground } from '#oracle/search-background.ts'
import { HydraError } from '#store/errors.ts'
import type { CommandRequest } from './dispatch.ts'

const ORACLE_LIMIT = 100

// `oracle <text> [<workspace>] [hydra]`: searches tasks, events and transcripts on demand.
export function oracleCommand({
  ws,
  id,
  args,
  fail,
  send,
  hydraId,
  searches,
}: CommandRequest & {
  hydraId: string
  searches: WeakMap<CommandRequest['ws'], AbortController>
}) {
  if (!args.length) {
    const controller = searches.get(ws)
    controller?.abort()
    searches.delete(ws)
    send({
      ws,
      message: {
        type: 'receipt',
        id,
        cancelled: Boolean(controller),
      },
    })

    return
  }

  if (args.length > 4 || (args[2] !== undefined && args[2] !== 'hydra' && args[2] !== '')) {
    throw new HydraError({
      message: 'oracle expects text, optional workspace, Hydra scope and filters',
      code: 'VALIDATION_ERROR',
    })
  }

  const filters = readSearchFilters({ value: args[3] })
  const query = {
    ...filters,
    text: args[0] ?? '',
    ...(args[1] ? { workspace: args[1] } : {}),
    ...(args[2] === 'hydra' ? { live: true } : {}),
    limit: ORACLE_LIMIT,
    highlight: true,
  }

  searches.get(ws)?.abort()
  const controller = new AbortController()
  searches.set(
    ws,
    controller,
  )

  // Never rejects, so nothing is lost by not awaiting it.
  const answer = async () => {
    try {
      send({
        ws,
        message: {
          type: 'receipt',
          id,
          ...await searchInBackground({
            hydraId,
            query,
            signal: controller.signal,
          }),
        },
      })
    } catch (error) {
      fail({
        error: (error as Error).message,
        code: error instanceof HydraError ? error.code : 'UNKNOWN',
      })
    } finally {
      if (searches.get(ws) === controller) {
        searches.delete(ws)
      }
    }
  }

  answer()
}
