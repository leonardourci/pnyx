import { COMMON, guard, integer, parse } from '#app/cli-support.ts'
import { logsDir } from '#app/diagnostics.ts'
import { oneDecimal } from '#app/log-line.ts'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { askHost } from '#app/server-state.ts'
import { readSettings } from '#settings/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { HydraError } from '#store/errors.ts'
import { clearLogs, logFiles, MB } from './log-files.ts'
import { PERFORMANCE_WINDOW_MS, SLOWEST_LIMIT, SLOWEST_MAX, performanceReport } from './performance.ts'
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

function readLimit({
  value,
  fallback,
  max,
}: {
  value: string | boolean | undefined
  fallback: number
  max: number
}): number {
  const limit = integer({
    value,
    flag: '--limit',
  }) ?? fallback

  if (limit < 1 || limit > max) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: `--limit must be between 1 and ${max}`,
    })
  }

  return limit
}

function onlyFlags({
  values,
  allowed,
  usage,
}: {
  values: Record<string, unknown>
  allowed: string[]
  usage: string
}): void {
  if (Object.keys(values).some(key => !allowed.includes(key))) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: usage,
    })
  }
}

type Values = Record<string, string | boolean | undefined>

async function performanceView({ values }: { values: Values }) {
  onlyFlags({
    values,
    allowed: [
      'hydra',
      'since',
      'until',
      'operation',
      'limit',
    ],
    usage: 'debug performance accepts only --hydra, --since, --until, --operation and --limit',
  })
  const until = instant({
    value: values.until,
    flag: '--until',
  }) ?? Date.now()
  const since = instant({
    value: values.since,
    flag: '--since',
  }) ?? until - PERFORMANCE_WINDOW_MS

  if (since > until) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: '--since must not follow --until',
    })
  }

  const report = await performanceReport({
    hydraId: values.hydra as string | undefined,
    since,
    until,
    operation: values.operation as string | undefined,
    limit: readLimit({
      value: values.limit,
      fallback: SLOWEST_LIMIT,
      max: SLOWEST_MAX,
    }),
  })

  return {
    ...report,
    operations: report.operations.length ? report.operations : 'none: no log lines in this window',
    memory: report.memory.length ? report.memory : 'none: no process lines in this window',
    slowest: report.slowest.length ? report.slowest : 'none: no timed actions in this window',
    help: [
      'Pass --since and --until (ISO timestamps with timezone) for another window; the default is the last hour',
      'Pass --operation <prefix> to keep one kind of action, or --hydra <id> for one Hydra and the server-wide lines',
    ],
  }
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
        operation: { type: 'string' },
      },
      positionals: 1,
    })

    if (positionals[0] === 'performance') {
      return performanceView({ values })
    }

    const limit = readLimit({
      value: values.limit,
      fallback: DEBUG_LIMIT,
      max: DEBUG_MAX,
    })

    if (positionals[0] === 'health') {
      onlyFlags({
        values,
        allowed: [
          'hydra',
          'limit',
        ],
        usage: 'debug health accepts only --hydra and --limit',
      })

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
        message: 'Use debug timeline, debug health or debug performance',
      })
    }

    if (values.operation !== undefined) {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: '--operation belongs to debug performance',
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

const KB = 1024

const fileSize = ({ bytes }: { bytes: number }) => {
  if (bytes < KB) {
    return `${bytes} B`
  }

  return bytes < MB ? `${oneDecimal({ value: bytes / KB })} KB` : `${oneDecimal({ value: bytes / MB })} MB`
}

// The log folder at a glance, and `logs clean` to delete every file now.
export const logs = guard({
  handler: ({ args }) => {
    const {
      positionals,
    } = parse({
      args,
      options: COMMON,
      positionals: 1,
    })

    if (positionals[0] === 'clean') {
      const cleared = clearLogs()

      return {
        deleted: cleared.files ? `${cleared.files} file${cleared.files === 1 ? '' : 's'}` : 'none: no log files',
        freed: fileSize({ bytes: cleared.bytes }),
      }
    }

    if (positionals[0] !== undefined) {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: 'Use logs or logs clean',
      })
    }

    const { settings } = readSettings()
    const files = logFiles()

    return {
      folder: logsDir(),
      logs: settings.logs,
      keepDays: settings.logDays,
      maxMB: settings.logMaxMB,
      files: files.length ? files.map(file => ({
        day: file.day,
        size: fileSize({ bytes: file.bytes }),
      })) : 'none: no log files yet',
      help: [
        'Run `pnyx-axi debug performance` for durations and memory from these lines',
        'Run `pnyx-axi logs clean` to delete every log file now',
      ],
    }
  },
})
