import { getHeapSpaceStatistics } from 'node:v8'
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import { log } from '#app/diagnostics.ts'
import { oneDecimal } from '#app/log-line.ts'

const PROCESS_LINE_MS = 30_000
// How often the event-loop delay histogram samples; a stall shorter than this is not seen.
const LOOP_DELAY_RESOLUTION_MS = 20
const LOOP_DELAY_PERCENTILE = 99
const NS_PER_MS = 1e6
const US_PER_MS = 1000
const PERCENT = 100
// The loop's share of time keeps two decimals.
const SHARE_DECIMALS = 100

// One line every 30 seconds by default with the server's CPU, event-loop delay and use, heap and garbage-collection pauses.
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

  // The histogram records the time between its timer's firings, so the interval itself is taken off; a timer that
  // fired a little early reads as no delay.
  const loopDelay = ({ ns }: { ns: number }) => oneDecimal({
    value: Math.max(
      0,
      ns / NS_PER_MS - LOOP_DELAY_RESOLUTION_MS,
    ),
  })

  const sample = () => {
    const now = performance.now()
    const span = now - since
    const used = process.cpuUsage(cpu)
    const memory = process.memoryUsage()
    const large = getHeapSpaceStatistics().find(space => space.space_name === 'large_object_space')
    const loopShare = performance.eventLoopUtilization(loop).utilization

    log({
      operation: 'process',
      ms: span,
      // Percent of one core, so it can pass 100.
      cpuPercent: oneDecimal({ value: (used.user + used.system) / US_PER_MS / span * PERCENT }),
      loopUtilization: Math.round(loopShare * SHARE_DECIMALS) / SHARE_DECIMALS,
      loopDelayMs: loopDelay({ ns: delay.mean }),
      loopDelayP99Ms: loopDelay({ ns: delay.percentile(LOOP_DELAY_PERCENTILE) }),
      loopDelayMaxMs: loopDelay({ ns: delay.max }),
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
