import { getHeapSpaceStatistics } from 'node:v8'
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import { log } from '#app/diagnostics.ts'
import { oneDecimal } from '#app/log-line.ts'

export const PROCESS_LINE_MS = 30_000
// How often the event-loop delay histogram samples; a stall shorter than this is not seen.
const LOOP_DELAY_RESOLUTION_MS = 20
const LOOP_DELAY_PERCENTILE = 99
const NS_PER_MS = 1e6
const US_PER_MS = 1000
const PERCENT = 100

// One line every 30 seconds with the server's CPU, event-loop delay and use, heap and garbage-collection pauses.
export function startProcessLines({ every = PROCESS_LINE_MS }: { every?: number }) {
  const delay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS })
  const gc = {
    count: 0,
    ms: 0,
    maxMs: 0,
  }
  // eslint-disable-next-line pnyx/object-params -- PerformanceObserver owns its callback signature.
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gc.count += 1
      gc.ms += entry.duration
      gc.maxMs = Math.max(
        gc.maxMs,
        entry.duration,
      )
    }
  })
  let since = performance.now()
  let loop = performance.eventLoopUtilization()
  let cpu = process.cpuUsage()

  delay.enable()
  observer.observe({ entryTypes: ['gc'] })

  const sample = () => {
    const now = performance.now()
    const span = now - since
    const used = process.cpuUsage(cpu)
    const memory = process.memoryUsage()
    const large = getHeapSpaceStatistics().find(space => space.space_name === 'large_object_space')

    log({
      operation: 'process',
      ms: span,
      // Of one core.
      cpuPercent: oneDecimal({ value: (used.user + used.system) / US_PER_MS / span * PERCENT }),
      loopUtilization: Math.round(performance.eventLoopUtilization(loop).utilization * PERCENT)
        / PERCENT,
      loopDelayMs: oneDecimal({ value: delay.mean / NS_PER_MS }),
      loopDelayP99Ms: oneDecimal({ value: delay.percentile(LOOP_DELAY_PERCENTILE) / NS_PER_MS }),
      loopDelayMaxMs: oneDecimal({ value: delay.max / NS_PER_MS }),
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      heapLarge: large?.space_used_size,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      gcCount: gc.count,
      gcMs: oneDecimal({ value: gc.ms }),
      gcMaxMs: oneDecimal({ value: gc.maxMs }),
    })

    since = now
    loop = performance.eventLoopUtilization()
    cpu = process.cpuUsage()
    delay.reset()
    gc.count = 0
    gc.ms = 0
    gc.maxMs = 0
  }

  const timer = setInterval(
    sample,
    every,
  ).unref()

  return {
    stop() {
      clearInterval(timer)
      delay.disable()
      observer.disconnect()
    },
  }
}
