import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { closeLogs, logsDir, openLogs } from '#app/diagnostics.ts'
import { startProcessLines } from './process-line.ts'

const SAMPLE_MS = 300
const POLL_MS = 50
const POLLS = 200
// The histogram samples every 20 ms, so a delay left with that interval in it reads 20 ms or more, while an idle
// loop that only waits for it has almost none of its own: a bound under 20 ms leaves room for a loaded machine.
const IDLE_DELAY_MAX_MS = 18

const processLines = () => readdirSync(logsDir()).flatMap(name => readFileSync(
  join(
    logsDir(),
    name,
  ),
  'utf8',
).split('\n'))
  .filter(Boolean)
  .map(text => JSON.parse(text) as Record<string, unknown>)
  .filter(line => line.operation === 'process')

test(
  'an idle server’s process line reports the event loop’s delay past its sampling interval, not the interval itself',
  async t => {
    openLogs()
    mkdirSync(
      logsDir(),
      { recursive: true },
    )
    const lines = startProcessLines({ every: SAMPLE_MS })
    t.after(() => {
      lines.stop()
      closeLogs()
    })
    let samples = processLines()

    for (let polls = 0; samples.length < 2; polls += 1) {
      assert.ok(
        polls < POLLS,
        `two process lines, found ${samples.length}`,
      )
      await delay(POLL_MS)
      samples = processLines()
    }

    for (const sample of samples) {
      assert.ok(
        Number(sample.loopDelayMs) < IDLE_DELAY_MAX_MS,
        `loopDelayMs ${String(sample.loopDelayMs)}`,
      )
      assert.ok(Number(sample.loopDelayMs) >= 0)
    }
  },
)
