import { MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { logged, PAGE_LINES_MAX, STACK_MAX, TEXT_MAX, type LogLine, type LogMode } from '#app/log-line.ts'

// The page's logger: the server's log() for the page. Lines wait here and go to the server in batches, which writes them marked as the page's.
const FLUSH_MS = 2000
// Lines kept while the socket is down; the oldest go first.
const QUEUE_MAX = 1000
// A UTF-16 code unit takes at most 3 bytes in UTF-8, so a batch this long fits the server's message limit with room for its frame.
const UTF8_BYTES_PER_UNIT = 3
const BATCH_LENGTH = Math.floor((MAX_MESSAGE_BYTES - 1024) / UTF8_BYTES_PER_UNIT)
const SLOW_FRAMES = 'long-animation-frame'
const LONG_TASKS = 'longtask'

// The long-animation-frame fields read here; TypeScript's DOM types do not describe that entry yet.
interface SlowFrame extends PerformanceEntry {
  blockingDuration?: number
  scripts?: {
    duration: number
    invoker?: string
  }[]
}

interface Output {
  // False while the socket is down, so the lines wait for the next flush.
  send({ lines }: { lines: string[] }): boolean
  hydra(): string
}

const tab = crypto.randomUUID().slice(
  0,
  8,
)
let mode: LogMode = 'on'
let queue: string[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let output: Output | undefined
// The owner's last send in Hydra's chat, until the reply's first text is on the page.
let sent: {
  started: number
  hydraId: string
} | undefined

const bounded = ({
  text,
  max = TEXT_MAX,
}: {
  text: string
  max?: number
}) => text.slice(
  0,
  max,
)

function pageError({ error }: { error: unknown }) {
  if (error instanceof Error) {
    return {
      name: bounded({ text: error.name }),
      message: bounded({ text: error.message }),
      stack: error.stack === undefined ? undefined : bounded({
        text: error.stack,
        max: STACK_MAX,
      }),
    }
  }

  return { message: bounded({ text: String(error) }) }
}

function flush() {
  timer = undefined

  while (queue.length && output) {
    let length = 0
    let count = 0

    for (const line of queue.slice(
      0,
      PAGE_LINES_MAX,
    )) {
      if (count && length + line.length > BATCH_LENGTH) {
        break
      }

      length += line.length + 1
      count += 1
    }

    if (!output.send({
      lines: queue.slice(
        0,
        count,
      ),
    })) {
      break
    }

    queue = queue.slice(count)
  }

  if (queue.length) {
    schedule()
  }
}

function schedule() {
  if (!timer) {
    timer = setTimeout(
      flush,
      FLUSH_MS,
    )
  }
}

export const setLogMode = ({ mode: next }: { mode: LogMode }) => {
  mode = next
}

// One line, as the server writes it: a plain call is an action, detailed lines wait for detailed logging, warnings and errors are always sent.
// eslint-disable-next-line pnyx/object-params -- the line passes on whole, so nothing is copied before the level check.
export function log(line: LogLine): void {
  if (!logged({
    mode,
    line,
  })) {
    return
  }

  const {
    error,
    ...fields
  } = line
  queue.push(JSON.stringify({
    ...fields,
    at: new Date().toISOString(),
    tab,
    hydraId: fields.hydraId ?? output?.hydra(),
    error: line.level && error !== undefined ? pageError({ error }) : undefined,
  }))

  if (queue.length > QUEUE_MAX) {
    queue = queue.slice(-QUEUE_MAX)
  }

  schedule()
}

// The owner sent a message in Hydra's chat; the first streamed text after it ends the line.
export const markSend = ({ hydraId }: { hydraId: string }) => {
  sent = {
    started: performance.now(),
    hydraId,
  }
}

export function firstTextShown() {
  if (!sent) {
    return
  }

  log({
    operation: 'page.first-text',
    hydraId: sent.hydraId,
    ms: performance.now() - sent.started,
  })
  sent = undefined
}

// Watches the frames and long tasks the browser reports as slow, and the page's uncaught errors, until stopped.
export function startPageLog({
  send,
  hydra,
}: Output) {
  output = {
    send,
    hydra,
  }
  const frames = PerformanceObserver.supportedEntryTypes.includes(SLOW_FRAMES)
  // eslint-disable-next-line pnyx/object-params -- PerformanceObserver owns its callback signature.
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as SlowFrame[]) {
      const longest = entry.scripts?.toSorted((
        a,
        b,
      ) => b.duration - a.duration)[0]
      log({
        operation: frames ? 'page.slow-frame' : 'page.long-task',
        ms: entry.duration,
        blockingMs: entry.blockingDuration,
        script: longest?.invoker === undefined ? undefined : bounded({ text: longest.invoker }),
      })
    }
  })
  observer.observe({ type: frames ? SLOW_FRAMES : LONG_TASKS })

  // eslint-disable-next-line pnyx/object-params -- addEventListener owns the handler signature.
  const failed = (event: ErrorEvent) => log({
    level: 'error',
    operation: 'page.error',
    error: event.error ?? event.message,
  })
  // eslint-disable-next-line pnyx/object-params -- addEventListener owns the handler signature.
  const rejected = (event: PromiseRejectionEvent) => log({
    level: 'error',
    operation: 'page.error',
    name: 'unhandled rejection',
    error: event.reason,
  })
  addEventListener(
    'error',
    failed,
  )
  addEventListener(
    'unhandledrejection',
    rejected,
  )

  return () => {
    observer.disconnect()
    removeEventListener(
      'error',
      failed,
    )
    removeEventListener(
      'unhandledrejection',
      rejected,
    )
    flush()
    output = undefined
  }
}
