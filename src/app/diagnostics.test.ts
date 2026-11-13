import assert from 'node:assert/strict'
import fs, { readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, flushLogs, log, logsDir, openLogs, setLogMode, type LogLine } from './diagnostics.ts'
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
  async t => {
    openLogs()
    t.after(() => closeLogs())
    log({ operation: 'before the disk filled' })
    await flushLogs()
    const descriptors = () => readdirSync('/dev/fd').length
    const open = descriptors()
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    const write = fs.appendFile
    t.mock.method(
      fs,
      'appendFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns the filesystem callback signature.
      (
        _path: unknown,
        _text: unknown,
        _options: unknown,
        callback: fs.NoParamCallback,
      ) => {
        queueMicrotask(() => callback(Object.assign(
          new Error('no space left on device'),
          { code: 'ENOSPC' },
        )))
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
      'appendFile',
      write,
    )
    syncBuiltinESMExports()
    await flushLogs()
    assert.ok(
      descriptors() <= open,
      'each failed write closed its file',
    )
    assert.equal(
      errors.mock.calls.filter(call => String(call.arguments[0]).includes('"operation":"failed while full"')).length,
      20,
    )
    log({ operation: 'after the disk freed' })
    await flushLogs()
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

test(
  'a written line keeps only the known fields, bounds their text, always describes an error, and leaves out what a reader can recover',
  async t => {
    openLogs()
    t.after(() => closeLogs())
    const before = new Set(readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n')))
    // A wider object passed as a line, as a spread of a card or request would: its other fields stay out.
    const wider = {
      operation: 'wider',
      taskId: 'first',
      prompt: 'the owner’s message',
      token: 'secret',
    } as LogLine
    log(wider)
    log({
      operation: 'long',
      name: 'n'.repeat(5000),
    })
    log({
      level: 'error',
      operation: 'rejected without a reason',
      error: undefined,
    })
    setLogMode({ mode: 'detailed' })
    log({
      operation: 'frame',
      detailed: true,
      ms: 16.7,
    })
    setLogMode({ mode: 'on' })
    await flushLogs()
    const written = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(text => text && !before.has(text))
      .map(text => JSON.parse(text) as Record<string, unknown>)
    const line = ({ operation }: { operation: string }) => written
      .find(record => record.operation === operation)!

    assert.deepEqual(
      Object.keys(line({ operation: 'wider' })).toSorted(),
      [
        'at',
        'operation',
        'rss',
        'source',
        'taskId',
        'v',
      ],
    )
    assert.equal(
      String(line({ operation: 'long' }).name).length,
      200,
    )
    const failed = line({ operation: 'rejected without a reason' })
    assert.equal(
      (failed.error as { message?: string } | undefined)?.message,
      'undefined',
    )
    assert.equal(
      failed.pid,
      process.pid,
      'a failure keeps the process id',
    )
    assert.deepEqual(
      Object.keys(line({ operation: 'frame' })).toSorted(),
      [
        'at',
        'ms',
        'operation',
        'source',
        'v',
      ],
      'Detailed lines leave out the flag, the process id and the memory',
    )
  },
)

test(
  'logging returns before disk completion and bounds outstanding writes',
  async t => {
    openLogs()
    t.after(() => closeLogs())
    await flushLogs()
    const complete: (() => void)[] = []
    t.mock.method(
      fs,
      'appendFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns the filesystem callback signature.
      (
        _path: unknown,
        _text: unknown,
        _options: unknown,
        callback: fs.NoParamCallback,
      ) => {
        complete.push(() => callback(null))
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll(); syncBuiltinESMExports()
    })

    for (let index = 0; index < 1000; index++) {
      log({
        operation: 'disk stalled',
        count: index,
      })
    }

    assert.equal(
      complete.length,
      200,
      'a stalled disk cannot grow the server queue without a bound',
    )

    for (const finish of complete) {
      finish()
    }

    await flushLogs()
  },
)
