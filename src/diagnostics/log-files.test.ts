import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { closeLogs, log, logsDir, openLogs } from '#app/diagnostics.ts'
import { logDay } from '#app/log-line.ts'
import { cleanLogs, clearLogs, MB } from './log-files.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const today = logDay({ at: new Date().toISOString() })
const yesterday = logDay({ at: new Date(Date.now() - DAY_MS).toISOString() })

const dayPath = ({ day }: { day: string }) => join(
  logsDir(),
  `${day}.jsonl`,
)

// One parseable line of filler, so the file reaches a size without a line the readers would refuse.
const pad = ({
  day,
  bytes,
}: {
  day: string
  bytes: number
}) => appendFileSync(
  dayPath({ day }),
  `${JSON.stringify({
    v: 1,
    at: `${day}T00:00:00.000Z`,
    operation: 'filler',
    pad: 'x'.repeat(bytes),
  })}\n`,
)

const lines = ({ day }: { day: string }) => readFileSync(
  dayPath({ day }),
  'utf8',
).split('\n')
  .filter(Boolean)
  .map(text => JSON.parse(text) as Record<string, unknown>)

const fresh = ({ t }: { t: TestContext }) => {
  openLogs()
  clearLogs()
  t.after(() => {
    clearLogs()
    closeLogs()
  })
  log({ operation: 'first' })
}

test(
  'once today’s file passes twice the cap, warnings and errors are dropped too, and the next cleanup writes how many',
  t => {
    fresh({ t })
    pad({
      day: today,
      bytes: 2.5 * MB,
    })
    cleanLogs({
      days: 7,
      maxBytes: MB,
    })
    const before = statSync(dayPath({ day: today })).size

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      log({
        level: 'error',
        operation: 'failing in a loop',
        error: new Error(`attempt ${attempt}`),
      })
    }

    assert.equal(
      statSync(dayPath({ day: today })).size,
      before,
      'no failure line past twice the cap',
    )
    cleanLogs({
      days: 7,
      maxBytes: MB,
    })
    assert.deepEqual(
      lines({ day: today }).filter(line => line.operation === 'logs.dropped')
        .map(line => [
          line.level,
          line.count,
        ]),
      [
        [
          'warn',
          1000,
        ],
      ],
    )
  },
)

test(
  'a server that starts with today’s file past the cap keeps action lines out from its first line on',
  t => {
    fresh({ t })
    pad({
      day: today,
      bytes: 1.5 * MB,
    })
    // A restart: the next line opens today's file again.
    closeLogs()
    openLogs()
    cleanLogs({
      days: 7,
      maxBytes: MB,
    })

    for (let action = 0; action < 100; action += 1) {
      log({ operation: 'after the restart' })
    }

    assert.equal(
      lines({ day: today }).filter(line => line.operation === 'after the restart').length,
      0,
    )
  },
)

test(
  'a cleanup that finds today past the cap keeps action lines out even when it also deletes an older day',
  t => {
    fresh({ t })
    pad({
      day: yesterday,
      bytes: 0.5 * MB,
    })
    pad({
      day: today,
      bytes: 1.5 * MB,
    })
    cleanLogs({
      days: 7,
      maxBytes: MB,
    })
    assert.equal(
      existsSync(dayPath({ day: yesterday })),
      false,
      'yesterday did not fit beside today',
    )

    for (let action = 0; action < 1000; action += 1) {
      log({ operation: 'while full' })
    }

    cleanLogs({
      days: 7,
      maxBytes: MB,
    })
    const written = lines({ day: today })
    assert.equal(
      written.filter(line => line.operation === 'while full').length,
      0,
      'past the cap today takes no action line',
    )
    assert.equal(
      written.filter(line => line.operation === 'logs.full').length,
      1,
      'the cap is reported once',
    )
  },
)
