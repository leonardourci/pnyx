import { log } from './log.ts'

const SLOW_RENDER_MS = 32
const LOG_INTERVAL_MS = 5000
let last = -LOG_INTERVAL_MS
let count = 0
let worst = 0

export function reportRender({
  name,
  ms,
}: {
  name: string
  ms: number
}) {
  if (ms < SLOW_RENDER_MS) {
    return
  }

  count++
  worst = Math.max(
    worst,
    ms,
  )
  const now = performance.now()

  if (now - last < LOG_INTERVAL_MS) {
    return
  }

  log({
    operation: 'page.render-commit',
    name,
    ms: worst,
    count,
  })
  last = now; count = 0; worst = 0
}
