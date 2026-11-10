import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { asRecord } from '#app/command-validation.ts'
import { oneDecimal } from '#app/log-line.ts'
import { logFiles, MB } from './log-files.ts'

export const PERFORMANCE_WINDOW_MS = 60 * 60 * 1000
export const SLOWEST_LIMIT = 10
export const SLOWEST_MAX = 100
const OPERATIONS_SHOWN = 30
const MEMORY_POINTS = 24
// Every line starts with its version and time, so lines outside the window are skipped without parsing them.
const LINE_START = '{"v":1,"at":"'
const ISO_LENGTH = '2026-01-01T00:00:00.000Z'.length

interface Line {
  at: string
  operation: string
  name?: string
  level?: string
  hydraId?: string
  taskId?: string
  sessionId?: string
  source?: string
  ms?: number
  rss?: number
  heapUsed?: number
  cpuPercent?: number
  loopDelayP99Ms?: number
}

interface Group {
  count: number
  errors: number
  durations: number[]
}

const number = ({ value }: { value: unknown }) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

const string = ({ value }: { value: unknown }) => typeof value === 'string' ? value : undefined

function readLine({ text }: { text: string }): Line | undefined {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  const record = asRecord({ value })
  const at = string({ value: record?.at })
  const operation = string({ value: record?.operation })

  if (!record || record.v !== 1 || !at || !operation) {
    return undefined
  }

  return {
    at,
    operation,
    name: string({ value: record.name }),
    level: string({ value: record.level }),
    hydraId: string({ value: record.hydraId }),
    taskId: string({ value: record.taskId }),
    sessionId: string({ value: record.sessionId }),
    source: string({ value: record.source }),
    ms: number({ value: record.ms }),
    rss: number({ value: record.rss }),
    heapUsed: number({ value: record.heapUsed }),
    cpuPercent: number({ value: record.cpuPercent }),
    loopDelayP99Ms: number({ value: record.loopDelayP99Ms }),
  }
}

// The operation and its name when it has one, so `command.cli task create` and `command.cli task show` stay apart.
const label = ({ line }: { line: Line }) => line.name ? `${line.operation} ${line.name}` : line.operation

const megabytes = ({ bytes }: { bytes?: number }) => bytes === undefined
  ? undefined
  : oneDecimal({ value: bytes / MB })

function median({ values }: { values: number[] }) {
  const sorted = values.toSorted((
    a,
    b,
  ) => a - b)

  return sorted[Math.floor(sorted.length / 2)]
}

// At most MEMORY_POINTS samples, keeping the highest memory of each stretch so a spike stays visible.
function memoryPoints({ samples }: { samples: Line[] }) {
  const stretch = Math.ceil(samples.length / MEMORY_POINTS)
  const points: Line[] = []

  for (let start = 0; start < samples.length; start += stretch) {
    const highest = samples.slice(
      start,
      start + stretch,
    ).reduce((
      high,
      sample,
    ) => (sample.rss ?? 0) > (high.rss ?? 0) ? sample : high)
    points.push(highest)
  }

  return points.map(point => ({
    at: point.at,
    rssMB: megabytes({ bytes: point.rss }),
    heapMB: megabytes({ bytes: point.heapUsed }),
    cpuPercent: point.cpuPercent,
    loopDelayP99Ms: point.loopDelayP99Ms,
  }))
}

// Reads the log lines in the window: each operation's count and its typical and worst duration, memory over time and the slowest actions.
export async function performanceReport({
  hydraId,
  since,
  until,
  operation,
  limit,
}: {
  hydraId?: string
  since: number
  until: number
  operation?: string
  limit: number
}) {
  const from = new Date(since).toISOString()
  const to = new Date(until).toISOString()
  const files = logFiles().filter(file => file.day >= from.slice(
    0,
    10,
  ) && file.day <= to.slice(
    0,
    10,
  ))
  const groups = new Map<string, Group>()
  const samples: Line[] = []
  // The slowest actions so far, slowest first.
  let slowest: Line[] = []
  let lines = 0

  for (const file of files) {
    const reader = createInterface({
      input: createReadStream(file.path),
      crlfDelay: Infinity,
    })

    for await (const text of reader) {
      const at = text.startsWith(LINE_START) ? text.slice(
        LINE_START.length,
        LINE_START.length + ISO_LENGTH,
      ) : undefined

      if (at !== undefined && (at < from || at > to)) {
        continue
      }

      const line = readLine({ text })
      // Lines without a Hydra, such as the process line, belong to every Hydra.
      const lineHydra = line?.hydraId
      const otherHydra = hydraId !== undefined && lineHydra !== undefined && lineHydra !== hydraId

      if (!line || line.at < from || line.at > to || otherHydra) {
        continue
      }

      if (line.operation === 'process') {
        samples.push(line)

        continue
      }

      if (operation !== undefined && !line.operation.startsWith(operation)) {
        continue
      }

      lines += 1
      const key = label({ line })
      const group = groups.get(key) ?? {
        count: 0,
        errors: 0,
        durations: [],
      }
      group.count += 1

      if (line.level === 'error') {
        group.errors += 1
      }

      const ms = line.ms

      if (ms !== undefined) {
        group.durations.push(ms)
        const fastestKept = slowest.at(-1)?.ms

        if (slowest.length < limit || fastestKept === undefined || ms > fastestKept) {
          slowest = [
            ...slowest,
            line,
          ].toSorted((
            a,
            b,
          ) => (b.ms ?? 0) - (a.ms ?? 0))
            .slice(
              0,
              limit,
            )
        }
      }

      groups.set(
        key,
        group,
      )
    }
  }

  const operations = [...groups].map(([
    key,
    group,
  ]) => ({
    operation: key,
    count: group.count,
    typicalMs: group.durations.length ? median({ values: group.durations }) : undefined,
    worstMs: group.durations.length ? group.durations.reduce((
      worst,
      ms,
    ) => Math.max(
      worst,
      ms,
    )) : undefined,
    totalMs: oneDecimal({
      value: group.durations.reduce(
        (
          sum,
          ms,
        ) => sum + ms,
        0,
      ),
    }),
    errors: group.errors,
  }))
    .toSorted((
      a,
      b,
    ) => b.totalMs - a.totalMs || b.count - a.count)

  return {
    since: from,
    until: to,
    lines,
    operations: operations.slice(
      0,
      OPERATIONS_SHOWN,
    ),
    operationsTruncated: operations.length > OPERATIONS_SHOWN,
    memory: memoryPoints({ samples }),
    slowest: slowest.map(line => ({
      at: line.at,
      operation: label({ line }),
      ms: line.ms,
      source: line.source,
      hydraId: line.hydraId,
      taskId: line.taskId,
    })),
  }
}
