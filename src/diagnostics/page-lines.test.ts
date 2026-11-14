import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, flushLogs, logsDir, openLogs } from '#app/diagnostics.ts'
import { logPageLines } from './page-lines.ts'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

test(
  'a page line queued while the socket was down is placed at its age on the page’s monotonic clock, within a bound',
  async t => {
    openLogs()
    t.after(() => closeLogs())
    const sent = Date.now()
    logPageLines({
      value: [
        {
          operation: 'page.socket',
          status: 'lost',
          ageMs: 10 * MINUTE_MS,
        },
        {
          operation: 'page.long-task',
          ms: 80,
          ageMs: -5,
        },
        {
          operation: 'page.slow-frame',
          ms: 90,
          ageMs: 3 * DAY_MS,
        },
      ],
    })
    await flushLogs()
    const at = Object.fromEntries(readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .map(line => [
        line.operation,
        Date.parse(String(line.at)),
      ]))
    assert.ok(
      Math.abs(sent - 10 * MINUTE_MS - at['page.socket']!) < 1000,
      'ten minutes before it arrived',
    )
    assert.ok(
      Math.abs(sent - at['page.long-task']!) < 1000,
      'a negative age takes the arrival time',
    )
    assert.ok(
      Math.abs(sent - at['page.slow-frame']!) < 1000,
      'an age past the bound takes the arrival time',
    )
  },
)
