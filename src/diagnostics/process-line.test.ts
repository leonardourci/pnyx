import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { closeLogs, logsDir, openLogs } from '#app/diagnostics.ts'
import { startProcessLines } from './process-line.ts'

const SAMPLE_MS = 300

test(
  'an idle server’s process line reports the event loop’s delay past its sampling interval, not the interval itself',
  async t => {
    openLogs()
    const lines = startProcessLines({ every: SAMPLE_MS })
    t.after(() => {
      lines.stop()
      closeLogs()
    })
    await delay(SAMPLE_MS * 3 + SAMPLE_MS / 2)
    const samples = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .filter(line => line.operation === 'process')

    assert.ok(samples.length >= 2)

    // The histogram samples every 20 ms; an idle loop that only waits for it has almost no delay of its own.
    for (const sample of samples) {
      assert.ok(
        Number(sample.loopDelayMs) < 15,
        `loopDelayMs ${String(sample.loopDelayMs)}`,
      )
      assert.ok(Number(sample.loopDelayMs) >= 0)
    }
  },
)
