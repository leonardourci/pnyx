import { MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { logged, PAGE_LINES_MAX, SAMPLE_MS, STACK_MAX, TEXT_MAX, type LogMode, type PageLine } from '#app/log-line.ts'

// The page's log(): lines queue here and go to the server in batches over the socket, which writes them with source web.
const FLUSH_MS = 2000
// Lines kept while the socket is down; past this many, the oldest are dropped.
const QUEUE_MAX = 1000
// A UTF-16 code unit takes at most 3 bytes in UTF-8, so a batch this long fits the server's message limit, with 1 KB left for the JSON around the lines.
const UTF8_BYTES_PER_UNIT = 3
const MESSAGE_ROOM_BYTES = 1024
const BATCH_LENGTH = Math.floor((MAX_MESSAGE_BYTES - MESSAGE_ROOM_BYTES) / UTF8_BYTES_PER_UNIT)
const SLOW_FRAMES = 'long-animation-frame'
const LONG_TASKS = 'longtask'
// A reply's first text later than this belongs to something else, such as a wake long after the send.
const FIRST_TEXT_MAX_MS = 5 * 60_000
// A reveal frame counts as slow past this many of the display's frames; the display's frame is the shortest one seen.
const SLOW_FRAME_BUDGETS = 1.5
const DISPLAY_FRAME_MS = 1000 / 60
// No display refreshes faster than this, so a shorter interval, such as two ticks in one frame, says nothing about it.
const FASTEST_FRAME_MS = 1000 / 240

// The long-animation-frame fields read here; TypeScript's DOM types do not describe that entry yet.
interface SlowFrame extends PerformanceEntry {
  blockingDuration?: number
  scripts?: {
    duration: number
    invoker?: string
  }[]
}

// Chromium's JS heap figure; other browsers have none, and the line leaves it out.
type HeapPerformance = Performance & { memory?: { usedJSHeapSize: number } }

interface Output {
  // False while the socket is down, so the lines wait for the next flush.
  send({ lines }: { lines: string[] }): boolean
  hydra(): string
  // The chat the page holds: the length of the frames that brought it, and its messages.
  chat(): {
    chars: number
    messages: number
  }
}

const tab = crypto.randomUUID().slice(
  0,
  8,
)
let mode: LogMode = 'on'
// Each line with when it was queued on the monotonic clock, so it is sent with its age.
let queue: {
  text: string
  queued: number
}[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let output: Output | undefined
// The owner's last send in each Hydra's chat, until the reply's first text is on the page.
const sent = new Map<string, number>()
// The reveal frames since the last live update's line, and the slowest of them.
let frames = 0, worstFrameMs = 0, frameBudget = DISPLAY_FRAME_MS

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

// How many queued lines the next message takes: at least one, and at most PAGE_LINES_MAX or BATCH_LENGTH code units.
export function batchSize({ lines }: { lines: string[] }): number {
  let length = 0
  let count = 0

  for (const line of lines.slice(
    0,
    PAGE_LINES_MAX,
  )) {
    if (count && length + line.length > BATCH_LENGTH) {
      break
    }

    length += line.length + 1
    count += 1
  }

  return count
}

function flush() {
  timer = undefined
  const now = performance.now()
  // Each line says how long ago it happened, so the server places one that waited for the socket without the page's wall clock.
  const lines = queue.map(entry => `{"ageMs":${Math.round(now - entry.queued)},${entry.text.slice(1)}`)
  let delivered = 0

  while (delivered < lines.length && output) {
    const batch = lines.slice(
      delivered,
      delivered + PAGE_LINES_MAX,
    )
    const count = batchSize({ lines: batch })

    if (!output.send({
      lines: batch.slice(
        0,
        count,
      ),
    })) {
      break
    }

    delivered += count
  }

  queue = queue.slice(delivered)

  // Lines wait for a socket; without a sender they wait for the next start.
  if (queue.length && output) {
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

// Queues the line for the server when the level allows it: a detailed line only under Detailed, a warning or error always.
// eslint-disable-next-line pnyx/object-params -- the line passes on whole, so nothing is copied before the level check.
export function log(line: PageLine): void {
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
  // A line about no Hydra in particular belongs to the one the page shows.
  const selectedHydra = output?.hydra()
  queue.push({
    queued: performance.now(),
    text: JSON.stringify({
      ...fields,
      tab,
      hydraId: fields.hydraId ?? selectedHydra,
      error: line.level && error !== undefined ? pageError({ error }) : undefined,
    }),
  })

  if (queue.length > QUEUE_MAX) {
    queue = queue.slice(-QUEUE_MAX)
  }

  schedule()
}

// Starts timing the owner's send in Hydra's chat; firstTextShown logs the time to the reply's first text.
export const markSend = ({ hydraId }: { hydraId: string }) => {
  sent.set(
    hydraId,
    performance.now(),
  )
}

// A refused send, a turn that ended without streamed text or a chat the owner left has no first text to wait for.
export const forgetSend = ({ hydraId }: { hydraId: string }) => {
  sent.delete(hydraId)
}

export function firstTextShown({ hydraId }: { hydraId: string }) {
  const started = sent.get(hydraId)

  if (started === undefined) {
    return
  }

  sent.delete(hydraId)
  const ms = performance.now() - started

  if (ms <= FIRST_TEXT_MAX_MS) {
    log({
      operation: 'page.first-text',
      hydraId,
      ms,
    })
  }
}

// Counts one reveal frame for the next live update's line; at Detailed, a frame past the display's budget gets its own.
export function noteFrame({ ms }: { ms: number }) {
  if (mode !== 'detailed') {
    return
  }

  if (ms >= FASTEST_FRAME_MS) {
    frameBudget = Math.min(
      frameBudget,
      ms,
    )
  }

  frames += 1
  worstFrameMs = Math.max(
    worstFrameMs,
    ms,
  )

  if (ms > frameBudget * SLOW_FRAME_BUDGETS) {
    log({
      operation: 'page.frame',
      detailed: true,
      ms,
    })
  }
}

// The reveal frames since the last call, for a live update's line.
export function takeFrames() {
  const taken = {
    frames: frames || undefined,
    worstFrameMs: frames ? worstFrameMs : undefined,
  }
  frames = 0
  worstFrameMs = 0

  return taken
}

// The page's memory, read when the browser is idle so it never lands inside a reveal frame.
function memoryLine() {
  if (mode === 'off' || !output) {
    return
  }

  const chat = output.chat()
  log({
    operation: 'page.memory',
    chatChars: chat.chars,
    messages: chat.messages,
    elements: document.getElementsByTagName('*').length,
    heapUsed: (performance as HeapPerformance).memory?.usedJSHeapSize,
  })
}

const whenIdle = () => {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(memoryLine)
  } else {
    // Safari has no idle callback: right after a frame instead.
    requestAnimationFrame(() => setTimeout(
      memoryLine,
      0,
    ))
  }
}

// Watches the frames and long tasks the browser reports as slow, the page's uncaught errors and its memory, until stopped.
export function startPageLog({
  send,
  hydra,
  chat,
}: Output) {
  output = {
    send,
    hydra,
    chat,
  }
  schedule()
  const slowFramesSupported = PerformanceObserver.supportedEntryTypes.includes(SLOW_FRAMES)
  // eslint-disable-next-line pnyx/object-params -- PerformanceObserver owns its callback signature.
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as SlowFrame[]) {
      const longest = entry.scripts?.toSorted((
        a,
        b,
      ) => b.duration - a.duration)[0]
      log({
        operation: slowFramesSupported ? 'page.slow-frame' : 'page.long-task',
        ms: entry.duration,
        blockingMs: entry.blockingDuration,
        script: longest?.invoker === undefined ? undefined : bounded({ text: longest.invoker }),
      })
    }
  })
  observer.observe({ type: slowFramesSupported ? SLOW_FRAMES : LONG_TASKS })
  const memory = setInterval(
    whenIdle,
    SAMPLE_MS,
  )

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
  // A reload or a closed tab sends what is queued, such as the error that came before it.
  addEventListener(
    'pagehide',
    flush,
  )

  return () => {
    observer.disconnect()
    clearInterval(memory)
    removeEventListener(
      'error',
      failed,
    )
    removeEventListener(
      'unhandledrejection',
      rejected,
    )
    removeEventListener(
      'pagehide',
      flush,
    )
    flush()
    output = undefined
    clearTimeout(timer)
    timer = undefined
  }
}
