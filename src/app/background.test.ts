import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HydraError } from '#store/errors.ts'
import { background } from './background.ts'

test(
  'background failures and failed retries share searchable operation and event identities',
  t => {
    const output = t.mock.method(
      console,
      'error',
      () => {},
    )
    background({
      name: 'Hydra resume',
      context: {
        hydraId: 'lab',
        taskId: '$hydra',
        sessionId: 'codex:synthetic',
        correlationId: 'resume:synthetic',
      },
      run: () => {
        throw new HydraError({
          message: 'Controller unavailable\nTry attaching again',
          code: 'NATIVE_UNAVAILABLE',
        })
      },
      retry: () => {
        throw new Error('Retry unavailable')
      },
    })
    const lines = output.mock.calls.map(call => String(call.arguments[0]))
    assert.equal(
      lines.length,
      2,
    )
    assert.ok(
      lines[0]?.startsWith('{'),
      'failures must be single JSON records',
    )
    const first = JSON.parse(lines[0]!)
    const retry = JSON.parse(lines[1]!)
    assert.equal(
      Number.isNaN(Date.parse(first.at)),
      false,
    )
    assert.equal(
      first.pid,
      process.pid,
    )
    assert.equal(
      typeof first.operationId,
      'string',
    )
    assert.ok(first.operationId.length > 0)
    assert.match(
      first.error.stack,
      /Controller unavailable/,
    )
    assert.equal(
      typeof first.rss,
      'number',
    )
    assert.deepEqual(
      first,
      {
        v: 1,
        at: first.at,
        level: 'error',
        source: 'server',
        pid: process.pid,
        operation: 'Hydra resume',
        operationId: first.operationId,
        hydraId: 'lab',
        taskId: '$hydra',
        sessionId: 'codex:synthetic',
        correlationId: 'resume:synthetic',
        rss: first.rss,
        error: {
          name: 'Error',
          message: 'Controller unavailable\nTry attaching again',
          code: 'NATIVE_UNAVAILABLE',
          stack: first.error.stack,
        },
      },
    )
    assert.deepEqual(
      retry,
      {
        v: 1,
        at: retry.at,
        level: 'error',
        source: 'server',
        pid: process.pid,
        operation: 'Hydra resume retry',
        operationId: first.operationId,
        hydraId: 'lab',
        taskId: '$hydra',
        sessionId: 'codex:synthetic',
        correlationId: 'resume:synthetic',
        rss: retry.rss,
        error: {
          name: 'Error',
          message: 'Retry unavailable',
          stack: retry.error.stack,
        },
      },
    )
  },
)

test(
  'concurrent background failures keep each Hydra context and successful work stays quiet',
  async t => {
    const output = t.mock.method(
      console,
      'error',
      () => {},
    )
    let release = () => {}
    let failed = () => {}
    const held = new Promise<void>(resolve => release = resolve)
    const finished = new Promise<void>(resolve => failed = resolve)
    background({
      name: 'held operation',
      context: { hydraId: 'first' },
      run: async () => {
        await held
        throw 'Provider disconnected'
      },
      retry: () => failed(),
    })
    background({
      name: 'successful operation',
      context: { hydraId: 'second' },
      run: () => {},
    })
    background({
      name: 'other operation',
      context: { hydraId: 'second' },
      run: () => {
        throw new Error('Unavailable')
      },
    })
    release()
    await finished
    const lines = output.mock.calls.map(call => String(call.arguments[0]))
    assert.equal(
      lines.length,
      2,
    )
    assert.ok(
      lines[0]?.startsWith('{'),
      'failures must be single JSON records',
    )
    const other = JSON.parse(lines[0]!)
    const delayed = JSON.parse(lines[1]!)
    assert.equal(
      other.hydraId,
      'second',
    )
    assert.equal(
      delayed.hydraId,
      'first',
    )
    assert.notEqual(
      other.operationId,
      delayed.operationId,
    )
    assert.deepEqual(
      delayed.error,
      { message: 'Provider disconnected' },
    )
  },
)

test(
  'a context-free failure with circular metadata is logged and still retries',
  t => {
    const output = t.mock.method(
      console,
      'error',
      () => {},
    )
    const failure = Object.create(null)
    failure.self = failure
    let retried = false
    background({
      name: 'external failure',
      run: () => {
        throw failure
      },
      retry: () => {
        retried = true
      },
    })
    assert.equal(
      retried,
      true,
    )
    assert.equal(
      output.mock.calls.length,
      1,
    )
    const record = JSON.parse(String(output.mock.calls[0]!.arguments[0]))
    assert.equal(
      record.operation,
      'external failure',
    )
    assert.equal(
      record.hydraId,
      undefined,
    )
    assert.equal(
      typeof record.error.message,
      'string',
    )
    assert.ok(record.error.message.length > 0)
  },
)
