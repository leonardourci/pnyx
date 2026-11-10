import assert from 'node:assert/strict'
import fs, { readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, log, logsDir, openLogs, type LogLine } from './diagnostics.ts'
import { logged } from './log-line.ts'

test(
  'outside the server a warning or an error prints one JSON line on stderr, and a plain or detailed line prints nothing',
  t => {
    const output = t.mock.method(
      console,
      'error',
      () => {},
    )
    log({
      operation: 'quiet',
      ms: 3,
    })
    log({
      operation: 'quiet detail',
      detailed: true,
    })
    log({
      level: 'warn',
      operation: 'warned',
    })
    log({
      level: 'error',
      operation: 'failed',
      error: { reason: 'x'.repeat(5000) },
    })
    const lines = output.mock.calls.map(call => JSON.parse(String(call.arguments[0])))
    assert.deepEqual(
      lines.map(line => [
        line.level,
        line.operation,
      ]),
      [
        [
          'warn',
          'warned',
        ],
        [
          'error',
          'failed',
        ],
      ],
    )
    assert.ok(
      lines[1].error.message.length <= 2000,
      'a thrown value that is not an Error is inspected within a bound',
    )
  },
)

test(
  'the line type refuses an error line without its error, an error on a normal line and a detailed warning or error',
  () => {
    // @ts-expect-error an error line carries the error it reports
    const missing: LogLine = {
      operation: 'failed',
      level: 'error',
    }
    // @ts-expect-error a normal line carries no error
    const normal: LogLine = {
      operation: 'done',
      error: new Error('unexpected'),
    }
    // @ts-expect-error a warning is never detailed
    const warning: LogLine = {
      operation: 'warned',
      level: 'warn',
      detailed: true,
    }
    // @ts-expect-error an error is never detailed
    const failure: LogLine = {
      operation: 'failed',
      level: 'error',
      error: 'lost',
      detailed: true,
    }
    const accepted: LogLine[] = [
      {
        operation: 'done',
        ms: 1,
      },
      {
        operation: 'frame',
        detailed: true,
      },
      {
        operation: 'warned',
        level: 'warn',
      },
      {
        operation: 'failed',
        level: 'error',
        error: new Error('lost'),
      },
    ]
    void [
      missing,
      normal,
      warning,
      failure,
    ]
    assert.deepEqual(
      accepted.map(line => logged({
        mode: 'on',
        line,
      })),
      [
        true,
        false,
        true,
        true,
      ],
      'On writes action lines, warnings and errors, and drops detailed lines',
    )
  },
)

test(
  'a log write that fails keeps no file open and sends the failure to stderr, and the next line lands in the file again',
  t => {
    openLogs()
    t.after(() => closeLogs())
    log({ operation: 'before the disk filled' })
    const descriptors = () => readdirSync('/dev/fd').length
    const open = descriptors()
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    const write = fs.writeSync
    t.mock.method(
      fs,
      'writeSync',
      () => {
        throw Object.assign(
          new Error('no space left on device'),
          { code: 'ENOSPC' },
        )
      },
    )
    syncBuiltinESMExports()

    for (const attempt of Array.from({ length: 20 }).keys()) {
      log({
        level: 'error',
        operation: 'failed while full',
        error: `attempt ${attempt}`,
      })
    }

    t.mock.method(
      fs,
      'writeSync',
      write,
    )
    syncBuiltinESMExports()
    assert.ok(
      descriptors() <= open,
      'each failed write closed its file',
    )
    assert.equal(
      errors.mock.calls.filter(call => String(call.arguments[0]).includes('"operation":"failed while full"')).length,
      20,
    )
    log({ operation: 'after the disk freed' })
    const written = readdirSync(logsDir()).map(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ))
      .join('')
    assert.match(
      written,
      /"operation":"after the disk freed"/,
    )
  },
)
