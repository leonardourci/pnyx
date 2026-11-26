import type { Query } from '#oracle/model.ts'
import { readSearchFilters } from '#oracle/filters.ts'
import { searchInBackground } from '#oracle/search-background.ts'
import { TitanError } from '#store/errors.ts'
import type { CommandRequest } from './dispatch.ts'

const ORACLE_LIMIT = 100

// `oracle <text> [<workspace>] [titan] [<filters>]` searches on demand; with no arguments it cancels this socket's search.
export function oracleCommand({
  ws,
  id,
  args,
  fail,
  send,
  titanId,
  searches,
}: CommandRequest & {
  titanId: string
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

  if (args.length > 4 || (args[2] !== undefined && args[2] !== 'titan' && args[2] !== '')) {
    throw new TitanError({
      message: 'oracle expects text, optional workspace, Titan scope and filters',
      code: 'VALIDATION_ERROR',
    })
  }

  const filters = readSearchFilters({ value: args[3] })
  const query: Query = {
    ...filters,
    text: args[0] ?? '',
    ...(args[1] ? { workspace: args[1] } : {}),
    ...(args[2] === 'titan' ? { live: true } : {}),
    limit: ORACLE_LIMIT,
    includeParts: true,
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
            titanId,
            query,
            signal: controller.signal,
          }),
        },
      })
    } catch (error) {
      fail({
        error: (error as Error).message,
        code: error instanceof TitanError ? error.code : 'UNKNOWN',
      })
    } finally {
      if (searches.get(ws) === controller) {
        searches.delete(ws)
      }
    }
  }

  answer()
}
