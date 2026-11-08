import { COMMON, guard, integer, parse } from '#app/cli-support.ts'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { askHost } from '#app/server-state.ts'
import { findCard } from '#tasks/push-rules.ts'
import { HydraError } from '#store/errors.ts'
import { DEBUG_LIMIT, DEBUG_MAX, serviceRows, timeline } from './timeline.ts'

function instant({
  value,
  flag,
}: {
  value: unknown
  flag: string
}): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: `${flag} expects an ISO timestamp with timezone`,
    })
  }

  return Date.parse(value)
}

export const debug = guard({
  handler: async ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        task: { type: 'string' },
        message: { type: 'string' },
        batch: { type: 'string' },
        session: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
      },
      positionals: 1,
    })
    const limit = integer({
      value: values.limit,
      flag: '--limit',
    }) ?? DEBUG_LIMIT

    if (limit < 1 || limit > DEBUG_MAX) {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: `--limit must be between 1 and ${DEBUG_MAX}`,
      })
    }

    if (positionals[0] === 'health') {
      if (Object.keys(values).some(key => ![
        'hydra',
        'limit',
      ].includes(key))) {
        throw new HydraError({
          code: 'VALIDATION_ERROR',
          message: 'debug health accepts only --hydra and --limit',
        })
      }

      return askHost({
        hydraId,
        body: {
          action: 'debug-health',
          limit,
        },
      })
    }

    if (positionals[0] !== 'timeline') {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: 'Use debug timeline or debug health',
      })
    }

    const since = instant({
      value: values.since,
      flag: '--since',
    })
    const until = instant({
      value: values.until,
      flag: '--until',
    })

    if (since !== undefined && until !== undefined && since > until) {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: '--since must not follow --until',
      })
    }

    const state = loadHydra({ hydraId }).state
    const ref = values.task
    const task = typeof ref === 'string' ? findCard({
      state,
      ref,
    }).id : undefined
    const service = serviceRows({ hydraId })
    const page = timeline({
      events: readEvents({ hydraId }),
      service: service.rows,
      filter: {
        task,
        message: values.message as string | undefined,
        batch: values.batch as string | undefined,
        session: values.session as string | undefined,
        since,
        until,
        limit,
        cursor: values.cursor as string | undefined,
      },
    })

    const entries = page.entries.map(row => {
      const fields = Object.entries(row).filter(([
        , value,
      ]) => value !== undefined)

      return Object.fromEntries(fields)
    })

    return {
      hydra: hydraId,
      ...page,
      entries: entries.length ? entries : 'none: no matching timeline records',
      serviceTailTruncated: service.truncated,
      help: ['Run `pnyx-axi debug timeline --help` for filters; pass the cursor with the same filters for older matches'],
    }
  },
})
