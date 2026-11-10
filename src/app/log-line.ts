// What one log line carries, shared by the server and the page so both write the same lines.

export const LOG_MODES = [
  'off',
  'on',
  'detailed',
] as const

// off keeps only warnings and errors; on writes one line per action; detailed adds a line per live update and frame.
export type LogMode = (typeof LOG_MODES)[number]

interface LogFields {
  operation: string
  hydraId?: string
  taskId?: string
  sessionId?: string
  correlationId?: string
  // Joins a failure to its retry.
  operationId?: string
  eventSeq?: number
  // Narrows the operation, such as the command, tool, message type or file; debug performance groups by operation and name.
  name?: string
  // Who asked: the owner's page or CLI, Hydra, or a worker.
  actor?: string
  status?: string
  code?: string
  exitCode?: number
  provider?: string
  // The server's process id: server.start has it, and a failure adds it itself.
  pid?: number
  // How long the action took, from the monotonic clock.
  ms?: number
  bytes?: number
  // Bytes still waiting in the socket after a send.
  backlog?: number
  count?: number
  // The page's tab, so lines from two tabs stay apart.
  tab?: string
  // The longest script in a slow page frame, as the browser names it.
  script?: string
  blockingMs?: number
  // The process line: CPU and event-loop use over the interval, loop delay, heap and garbage collection.
  cpuPercent?: number
  loopUtilization?: number
  loopDelayMs?: number
  loopDelayP99Ms?: number
  loopDelayMaxMs?: number
  heapUsed?: number
  heapTotal?: number
  heapLarge?: number
  external?: number
  arrayBuffers?: number
  gcCount?: number
  gcMs?: number
  gcMaxMs?: number
}

// Every field a line may carry besides its operation, id and duration: a line is built from these and nothing else
// its object holds, and a field added above must be listed here.
const FIELDS: { [Key in Exclude<keyof LogFields, 'operation' | 'operationId' | 'ms'>]-?: true } = {
  hydraId: true,
  taskId: true,
  sessionId: true,
  correlationId: true,
  eventSeq: true,
  name: true,
  actor: true,
  status: true,
  code: true,
  exitCode: true,
  provider: true,
  pid: true,
  bytes: true,
  backlog: true,
  count: true,
  tab: true,
  script: true,
  blockingMs: true,
  cpuPercent: true,
  loopUtilization: true,
  loopDelayMs: true,
  loopDelayP99Ms: true,
  loopDelayMaxMs: true,
  heapUsed: true,
  heapTotal: true,
  heapLarge: true,
  external: true,
  arrayBuffers: true,
  gcCount: true,
  gcMs: true,
  gcMaxMs: true,
}

export const LOG_FIELDS = new Set(Object.keys(FIELDS))

// One variant per severity: an error line needs its error, and warnings and errors are never detailed.
type Severity =
  | {
    level?: never
    error?: never
    // Written only while detailed logging is on.
    detailed?: boolean
  }
  | {
    level: 'warn'
    error?: unknown
    detailed?: never
  }
  | {
    level: 'error'
    error: unknown
    detailed?: never
  }

export type LogLine = LogFields & Severity

// Warnings and errors are always written; a detailed line needs detailed logging.
export const logged = ({
  mode,
  line,
}: {
  mode: LogMode
  line: Pick<LogLine, 'level' | 'detailed'>
}) => {
  if (line.level) {
    return true
  }

  return line.detailed ? mode === 'detailed' : mode !== 'off'
}

// A line's UTC day, which names the file it is written to.
export const logDay = ({ at }: { at: string }) => at.slice(
  0,
  10,
)

// A page sends at most this many lines in one message, each text at most TEXT_MAX long and a stack at most STACK_MAX.
export const PAGE_LINES_MAX = 100
export const TEXT_MAX = 200
export const STACK_MAX = 4000

// Durations keep a tenth of a millisecond, and percentages a tenth of a percent.
export const oneDecimal = ({ value }: { value: number }) => Math.round(value * 10) / 10
