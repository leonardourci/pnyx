import type { log as pageLog } from './log.ts'
import { TEXT_MAX, type PageLine } from '#app/log-line.ts'

export const UI_METRICS_INTERVAL_MS = 10_000
const GROUP_LIMIT = 32
const ENTRY_LIMIT = 128
const RENDER_SAMPLE = 10
const SLOW_INTERACTION_MS = 104
const FRAME_MS = 1000 / 60
const FASTEST_FRAME_MS = 1000 / 240
const TOKEN = /^[a-z][a-z0-9.-]{0,47}$/

const SURFACES = [
  'workspace',
  'chat',
  'settings',
  'oracle',
  'sortable',
  'task',
] as const
export type UISurface = (typeof SURFACES)[number]
type Sample = PageLine & {
  operation: string
  surface: UISurface
  action?: string
}
type Group = Sample & {
  count: number
  samples: number
  totalMs: number
  ms: number
}
interface SlowFrame extends PerformanceEntry {
  blockingDuration?: number
  scripts?: {
    duration: number
    invoker?: string
  }[]
}

interface InteractionEntry extends PerformanceEntry {
  interactionId: number
  target?: Node
  processingStart: number
  processingEnd: number
}

let enabled = true
let write: typeof pageLog | undefined
let start: (() => void) | undefined
let stop: (() => void) | undefined
const groups = new Map<string, Group>()
let overheadMs = 0
let callbacks = 0
let windowStarted = 0
let refused = 0
let generation = 0
const interactions = new Map<number, Sample>()
let endDrag: (() => void) | undefined

const measuring = () => enabled && write !== undefined

export function noteUIMetricsWork({ since }: { since: number }) {
  if (!measuring()) {
    return
  }

  overheadMs += performance.now() - since
  callbacks++
}

function record({
  sample,
  sampled = true,
}: {
  sample: Sample
  sampled?: boolean
}) {
  const key = `${sample.operation}:${sample.surface}:${sample.action ?? ''}:${sample.hydraId ?? ''}`
  const previous = groups.get(key)

  if (!previous && groups.size >= GROUP_LIMIT) {
    refused++

    return
  }

  const ms = sampled ? sample.ms ?? 0 : 0
  const worst = previous && previous.ms > ms ? previous : sample
  groups.set(
    key,
    {
      ...worst,
      name: sample.action ? `${sample.surface}.${sample.action}` : sample.surface,
      count: (previous?.count ?? 0) + 1,
      samples: (previous?.samples ?? 0) + Number(sampled),
      totalMs: (previous?.totalMs ?? 0) + ms,
      ms: Math.max(
        previous?.ms ?? 0,
        ms,
      ),
      frameCount: (previous?.frameCount ?? 0) + (sample.frameCount ?? 0),
      frames: (previous?.frames ?? 0) + (sample.frames ?? 0),
      worstFrameMs: Math.max(
        previous?.worstFrameMs ?? 0,
        sample.worstFrameMs ?? 0,
      ),
    },
  )
}

function flush() {
  if (!measuring()) {
    return
  }

  const since = performance.now()

  for (const sample of interactions.values()) {
    record({ sample })
  }

  interactions.clear()

  for (const sample of groups.values()) {
    write?.(sample)
  }

  groups.clear()
  noteUIMetricsWork({ since })
  write?.({
    operation: 'page.metrics-overhead',
    ms: overheadMs,
    totalMs: performance.now() - windowStarted,
    count: callbacks,
    samples: refused,
  })
  windowStarted = performance.now()
  overheadMs = 0; callbacks = 0; refused = 0
}

export function setUIMetricsEnabled({ enabled: next }: { enabled: boolean }) {
  if (enabled === next) {
    return
  }

  enabled = next
  generation++
  stop?.()
  stop = undefined
  groups.clear()
  interactions.clear()
  overheadMs = 0; callbacks = 0; refused = 0

  endDrag?.()

  if (enabled) {
    start?.()
  }
}

export function recordUIRender({
  surface,
  ms,
  hydraId,
}: {
  surface: UISurface
  ms: number
  hydraId?: string
}) {
  if (!measuring()) {
    return
  }

  const since = performance.now()
  const count = groups.get(`page.react-commit:${surface}::${hydraId ?? ''}`)?.count ?? 0
  record({
    sample: {
      operation: 'page.react-commit',
      surface,
      hydraId,
      ms,
    },
    sampled: count % RENDER_SAMPLE === 0,
  })
  noteUIMetricsWork({ since })
}

// Call once at the start, then finish after the flow settles; names are static tokens, never owner text.
export function timeUIFlow({
  surface,
  action,
  hydraId,
}: {
  surface: UISurface
  action: string
  hydraId?: string
}): () => void {
  if (!measuring() || !TOKEN.test(action)) {
    return () => {}
  }

  const started = performance.now()
  const startedGeneration = generation
  let finished = false

  return () => {
    if (finished || !measuring() || generation !== startedGeneration) {
      return
    }

    finished = true
    const since = performance.now()
    record({
      sample: {
        operation: 'page.flow',
        surface,
        hydraId,
        action,
        ms: since - started,
      },
    })
    noteUIMetricsWork({ since })
  }
}

export function trackUIDrag({
  action,
  hydraId,
}: {
  action: 'hydra' | 'project' | 'task'
  hydraId?: string
}): () => void {
  if (!measuring()) {
    return () => {}
  }

  endDrag?.()
  let frame = 0, previous = 0, budget = FRAME_MS, frames = 0, dropped = 0, worst = 0
  const started = performance.now()

  // eslint-disable-next-line pnyx/object-params -- requestAnimationFrame owns the callback signature.
  const tick = (now: number) => {
    if (finished || !measuring()) {
      return
    }

    const since = performance.now()

    if (previous && document.visibilityState === 'visible') {
      const ms = now - previous

      if (ms >= FASTEST_FRAME_MS) {
        budget = Math.min(
          budget,
          ms,
        )
        frames++
        dropped += Math.max(
          0,
          Math.round(ms / budget) - 1,
        )
        worst = Math.max(
          worst,
          ms,
        )
      }
    }

    previous = document.visibilityState === 'visible' ? now : 0
    frame = requestAnimationFrame(tick)
    noteUIMetricsWork({ since })
  }

  const visibility = () => {
    previous = 0
  }

  document.addEventListener(
    'visibilitychange',
    visibility,
  )
  let finished = false

  const finish = () => {
    if (finished) {
      return
    }

    finished = true
    cancelAnimationFrame(frame)
    document.removeEventListener(
      'visibilitychange',
      visibility,
    )
    endDrag = undefined

    if (measuring()) {
      record({
        sample: {
          operation: 'page.drag-frames',
          hydraId,
          surface: 'sortable',
          action,
          ms: performance.now() - started,
          frameCount: frames,
          frames: dropped,
          worstFrameMs: worst,
        },
      })
    }
  }

  endDrag = finish
  frame = requestAnimationFrame(tick)

  return finish
}

function context({ target }: { target?: Node }): {
  surface: UISurface
  action: string
  hydraId?: string
} {
  const element = target instanceof Element ? target : undefined
  const namedSurface = element?.closest('[data-ui-surface]')?.getAttribute('data-ui-surface') as UISurface | undefined
  let surface: UISurface = namedSurface && SURFACES.includes(namedSurface) ? namedSurface : 'workspace'
  const action = element?.closest('[data-ui-action]')?.getAttribute('data-ui-action')
  const control = element?.closest('button,input,textarea,select,[role="button"],[role="combobox"]')

  let fallback = control?.getAttribute('role') ?? control?.tagName.toLowerCase() ?? 'page'

  if (element?.closest('.card-open')) {
    fallback = 'task.toggle'
  }

  if (element?.closest('[data-drag-handle]')) {
    fallback = 'drag.pickup'
  }

  if (element?.closest('.composer-add')) {
    fallback = 'attachment.open'
  }

  if (element?.closest('.account-model-picker')) {
    fallback = 'model.pick'
  }

  if (element?.closest('button[type="submit"]')) {
    fallback = 'message.send'
  }

  if (element?.closest('.card')) {
    surface = 'task'
  }

  if (element?.closest('.oracle-palette')) {
    surface = 'oracle'
  }

  const namedAction = action ?? fallback

  return {
    hydraId: element?.closest('[data-hydra-workspace],[data-settings-hydra]')?.getAttribute('data-hydra-workspace') ?? element?.closest('[data-settings-hydra]')?.getAttribute('data-settings-hydra') ?? undefined,
    surface,
    action: TOKEN.test(namedAction) ? namedAction : 'page',
  }
}

export function startUIMetrics({ log }: { log: typeof pageLog }): () => void {
  write = log

  start = () => {
    windowStarted = performance.now()
    const observers: PerformanceObserver[] = []
    const captured: {
      type: string
      at: number
      context: ReturnType<typeof context>
    }[] = []

    // eslint-disable-next-line pnyx/object-params -- addEventListener owns the event signature.
    const capture = (event: Event) => {
      const since = performance.now()
      captured.push({
        type: event.type,
        at: event.timeStamp,
        context: context({ target: event.target instanceof Node ? event.target : undefined }),
      })

      if (captured.length > ENTRY_LIMIT) {
        captured.shift()
      }

      noteUIMetricsWork({ since })
    }

    const supportsEvents = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('event')
    const inputTypes = supportsEvents ? [
      'pointerdown',
      'pointerup',
      'click',
      'keydown',
      'keyup',
    ] : []
    inputTypes.forEach(type => addEventListener(
      type,
      capture,
      true,
    ))

    const observe = ({
      type,
      threshold,
    }: {
      type: string
      threshold?: number
    }) => {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes.includes(type)) {
        return
      }

      // eslint-disable-next-line pnyx/object-params -- PerformanceObserver owns its callback signature.
      const observer = new PerformanceObserver(list => {
        if (!measuring()) {
          return
        }

        const since = performance.now()
        const entries = list.getEntries()
        refused += Math.max(
          0,
          entries.length - ENTRY_LIMIT,
        )

        for (const entry of entries.slice(
          0,
          ENTRY_LIMIT,
        )) {
          if (type === 'event') {
            const event = entry as InteractionEntry

            if (!event.interactionId || event.duration < SLOW_INTERACTION_MS) {
              continue
            }

            const previous = interactions.get(event.interactionId)

            if (previous && (previous.ms ?? 0) >= event.duration) {
              continue
            }

            if (!previous && interactions.size >= ENTRY_LIMIT) {
              refused++
              continue
            }

            const capturedInput = captured.findLast(input => input.type === event.name
              && Math.abs(input.at - event.startTime) < 2)
            const eventContext = capturedInput?.context ?? context({ target: event.target })
            interactions.set(
              event.interactionId,
              {
                operation: 'page.slow-interaction',
                ...eventContext,
                ms: event.duration,
                inputDelayMs: event.processingStart - event.startTime,
                processingMs: event.processingEnd - event.processingStart,
                presentationMs: Math.max(
                  0,
                  event.startTime + event.duration - event.processingEnd,
                ),
              },
            )
          } else if (type === 'long-animation-frame') {
            const frame = entry as SlowFrame
            const longest = frame.scripts?.slice(
              0,
              ENTRY_LIMIT,
            ).reduce<{
              duration: number
              invoker?: string
            } | undefined>(
              (
                worst,
                script,
              ) =>
                !worst || script.duration > worst.duration ? script : worst,
              undefined,
            )
            record({
              sample: {
                operation: 'page.slow-frame',
                surface: 'workspace',
                ms: frame.duration,
                blockingMs: frame.blockingDuration,
                script: longest?.invoker?.slice(
                  0,
                  TEXT_MAX,
                ),
              },
            })
          } else {
            record({
              sample: {
                operation: 'page.long-task',
                surface: 'workspace',
                ms: entry.duration,
              },
            })
          }
        }

        noteUIMetricsWork({ since })
      })
      observer.observe({
        type,
        buffered: false,
        durationThreshold: threshold,
      } as PerformanceObserverInit)
      observers.push(observer)
    }

    observe({ type: 'longtask' })
    observe({ type: 'long-animation-frame' })
    observe({
      type: 'event',
      threshold: SLOW_INTERACTION_MS,
    })
    const timer = setInterval(
      flush,
      UI_METRICS_INTERVAL_MS,
    )
    addEventListener(
      'pagehide',
      flush,
    )

    stop = () => {
      observers.forEach(observer => observer.disconnect())
      inputTypes.forEach(type => removeEventListener(
        type,
        capture,
        true,
      ))
      captured.length = 0
      clearInterval(timer)
      removeEventListener(
        'pagehide',
        flush,
      )
    }
  }

  if (enabled) {
    start()
  }

  return () => {
    endDrag?.()

    flush()
    write = undefined
    generation++

    stop?.()
    stop = undefined; start = undefined; write = undefined
    groups.clear()
    interactions.clear()
  }
}
