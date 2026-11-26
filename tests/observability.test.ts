import { logPageLines } from '#diagnostics/page-lines.ts'
import { titanDir } from '#app/home-migration.ts'
import { spoolDir } from '#store/storage.ts'
import { ingestSpool } from '#integrations/hooks/ingest.ts'
import { scanEvents } from '#app/event-log.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { watchAgent } from '#workers/agent-memory.ts'
import { AsyncResource } from 'node:async_hooks'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { beforeAll, expect, test, vi } from 'vitest'
import { flushLogs, log, logMode, setLogBudget } from '#app/diagnostics.ts'
import { cleanLogs, logFiles } from '#diagnostics/log-files.ts'
import { withLogRequest } from '#diagnostics/context.ts'
import { flushRepeatedLines } from '#diagnostics/repeated-lines.ts'
import { logFailure } from '#diagnostics/log-failure.ts'
import { runProcess } from '#app/run-process.ts'
import { join } from 'node:path'
import { performanceReport } from '#diagnostics/performance.ts'
import { startProcessLines } from '#diagnostics/process-line.ts'
import { othrys as othrysCommand, startOthrys, until, type Othrys } from './setup/othrys.ts'

let othrys: Othrys
beforeAll(async () => {
  othrys = await startOthrys()
})

function lines() {
  return logFiles().flatMap(file => readFileSync(
    file.path,
    'utf8',
  ).trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line)))
}

test(
  'commands, HTTP, history and resource samples leave bounded measurements without message text',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"on"}',
      ],
    })
    await until({
      what: 'the server applies On logging',
      check: () => logMode() === 'on',
    })
    await flushLogs()
    const onStart = lines().length
    expect((await othrysCommand({
      args: [
        'titan',
        '--titan',
        titan.id,
        '--json',
      ],
      env: process.env,
    })).status).toBe(0)
    const spool = spoolDir({ dir: titanDir({ titanId: titan.id }) })
    mkdirSync(
      spool,
      { recursive: true },
    )
    const report = {
      key: 'observation',
      card: { title: 'Observation probe' },
      actor: 'command',
    }
    writeFileSync(
      join(
        spool,
        'observation-1.json',
      ),
      JSON.stringify({
        ...report,
        id: 'observation-1',
        at: '2026-01-01T00:00:00.000Z',
      }),
    )
    writeFileSync(
      join(
        spool,
        'observation-2.json',
      ),
      JSON.stringify({
        ...report,
        id: 'observation-2',
        at: '2026-01-01T00:00:01.000Z',
      }),
    )
    expect((await ingestSpool({ titanId: titan.id })).ingested).toBe(2)
    await fetch(`http://127.0.0.1:${othrys.port()}/health`)
    await flushLogs()
    const onLines = lines().slice(onStart)
    expect(onLines.some(line => line.operation === 'http.request' && line.status === '200')).toBe(false)
    expect(onLines.some(line => line.operation === 'events.read' && line.ms < 100)).toBe(false)
    expect(onLines.some(line => line.operation === 'hook.push')).toBe(false)
    expect(onLines.some(line => line.operation === 'card.observed')).toBe(false)
    expect(onLines.some(line => line.operation === 'command.cli')).toBe(true)
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"detailed"}',
      ],
    })
    await until({
      what: 'the server applies Detailed logging',
      check: () => logMode() === 'detailed',
    })
    expect((await othrysCommand({
      args: [
        'titan',
        '--titan',
        titan.id,
        '--json',
      ],
      env: process.env,
    })).status).toBe(0)
    await titan.owner({
      args: ['history'],
    })
    await fetch(`http://127.0.0.1:${othrys.port()}/health?token=private-request-value`)
    await flushLogs()
    const sampleStart = lines().length
    const cache = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
    )
    watchAgent({
      child: cache,
      ids: { titanId: titan.id },
    })
    const sample = startProcessLines({ every: 20 })

    try {
      await until({
        what: 'resource sample',
        check: async () => {
          await flushLogs()

          return lines().slice(sampleStart)
            .some(line => line.operation === 'agent.memory' && line.agents.some((agent: { rss: number }) => agent.rss > 0))
        },
      })
    } finally {
      sample.stop()
      cache.kill()
      await once(
        cache,
        'exit',
      )
    }

    logPageLines({
      value: [
        {
          operation: 'page.slow-interaction',
          surface: 'settings',
          action: 'settings.open',
          ms: 120,
          totalMs: 120,
          samples: 1,
          frameCount: 3,
          inputDelayMs: 8,
          processingMs: 100,
          presentationMs: 12,
          privateText: 'private-owner-message',
        },
        {
          operation: 'page.privacy',
          level: 'error',
          error: {
            name: 'Error',
            message: 'x'.repeat(200),
            stack: 'Error: ' + 'x'.repeat(200) + '\n    at private-page-secret\n    at app.js:1:2',
          },
        },
      ],
    })
    log({
      operation: 'privacy.probe',
      level: 'error',
      error: new Error(
        'private-owner-message token=secret\n    at private-message-frame',
        { cause: new Error('private-worker-message') },
      ),
    })
    await flushLogs()
    const recorded = lines()
    expect(recorded).toContainEqual(expect.objectContaining({
      source: 'web',
      operation: 'page.slow-interaction',
      surface: 'settings',
      action: 'settings.open',
      ms: 120,
      totalMs: 120,
      samples: 1,
      frameCount: 3,
      inputDelayMs: 8,
      processingMs: 100,
      presentationMs: 12,
    }))
    expect(recorded.find(line => line.operation === 'page.slow-interaction')).not.toHaveProperty('privateText')
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'command.cli',
        level: 'info',
        startedAt: expect.any(String),
        ms: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'http.request',
        name: 'health',
        status: '200',
        ms: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'events.read',
        count: expect.any(Number),
        ms: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'process',
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        activeResources: expect.any(Number),
        cpuPercent: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'storage',
        stateBytes: expect.any(Number),
        logBytes: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'privacy.probe',
        error: expect.objectContaining({
          fingerprint: expect.any(String),
          cause: expect.any(Object),
        }),
      }),
    ]))
    const scan = await withLogRequest({
      requestId: 'scan-probe',
      run: async () => {
        const events = [...scanEvents({ titanId: titan.id })]
        await flushLogs()

        return {
          count: events.length,
          lines: lines().filter(line => line.operation === 'events.read'
        && line.requestId === 'scan-probe'),
        }
      },
    })
    expect(scan.lines).toEqual([
      expect.objectContaining({
        name: 'scan',
        pages: 1,
        count: scan.count,
      }),
    ])
    const command = recorded.filter(line => line.operation === 'command.cli'
      && line.name === 'titan' && line.titanId === titan.id).at(-1)
    expect(command.requestId).toEqual(expect.any(String))
    expect(recorded).toContainEqual(expect.objectContaining({
      operation: 'http.request',
      requestId: command.requestId,
    }))
    expect(JSON.stringify(recorded)).not.toMatch(/private-owner-message|private-worker-message|private-request-value|private-message-frame|private-page-secret/)
  },
)

test(
  'the folder budget stops info, reserves errors and reports refused lines',
  async () => {
    await flushLogs()
    const today = logFiles().at(-1)!
    const olderPath = join(
      today.path,
      '..',
      '2026-01-01.jsonl',
    )
    writeFileSync(
      olderPath,
      '{}'.padEnd(3999) + '\n',
    )
    const budget = today.bytes + 6000
    cleanLogs({
      days: 10000,
      maxBytes: budget,
    })
    const stderr = vi.spyOn(
      console,
      'error',
    ).mockImplementation(() => {})

    try {
      for (let index = 0; index < 100; index += 1) {
        log({
          operation: 'info.storm',
          name: String(index),
        })
      }

      await flushLogs()
      const infoBytes = logFiles().at(-1)!.bytes
      expect(infoBytes).toBeLessThanOrEqual(budget - 4000 + 1000)
      expect(lines().filter(line => line.operation === 'logs.full')).toHaveLength(1)
      expect(lines().filter(line => line.operation === 'info.storm').length).toBeLessThan(100)

      for (let index = 0; index < 100; index += 1) {
        log({
          operation: 'failure.storm',
          level: 'error',
          error: new Error(`failure ${index}`),
        })
      }

      await flushLogs()
      const errors = lines().filter(line => line.operation === 'failure.storm')
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.length).toBeLessThan(100)
      expect(logFiles().at(-1)!.bytes).toBeGreaterThan(budget - 4000)
      expect(logFiles().at(-1)!.bytes).toBeLessThanOrEqual((budget - 4000) * 2)
      setLogBudget({})
      const stderrLines = stderr.mock.calls.map(([text]) => JSON.parse(text))
      expect(stderrLines).toContainEqual(expect.objectContaining({
        operation: 'logs.dropped',
        operationId: expect.any(String),
        count: expect.any(Number),
      }))
      const dropped = stderr.mock.calls.map(([text]) => JSON.parse(text))
        .find(line => line.operation === 'logs.dropped')
      expect(dropped.count).toBeGreaterThan(0)
      expect(lines().filter(line => line.operation === 'info.storm').length
        + errors.length + dropped.count).toBeGreaterThanOrEqual(200)
    } finally {
      stderr.mockRestore()
      rmSync(
        olderPath,
        { force: true },
      )
      setLogBudget({ maxBytes: 500 * 1024 * 1024 })
    }
  },
)

test(
  'request ids expire for continuations and stay separate from message correlation',
  async () => {
    let later: (() => void) | undefined
    await withLogRequest({
      requestId: 'first-request',
      run: async () => {
        log({
          operation: 'request.active',
          correlationId: 'message-id',
        })
        const resource = new AsyncResource('later-turn')
        later = () => resource.runInAsyncScope(() => log({ operation: 'request.later' }))
      },
    })
    later!()
    await flushLogs()
    expect(lines()).toContainEqual(expect.objectContaining({
      operation: 'request.active',
      requestId: 'first-request',
      correlationId: 'message-id',
    }))
    expect(lines().find(line => line.operation === 'request.later').requestId).toBeUndefined()
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"detailed"}',
      ],
    })
    const created = await othrysCommand({
      args: [
        'task',
        'create',
        '--title',
        'Request scope',
        '--brief',
        'Check request isolation',
        '--key',
        'request-scope',
        '--folder',
        titan.folder({ name: 'request-scope' }),
        '--harness',
        'claude',
        '--titan',
        titan.id,
        '--json',
      ],
      env: process.env,
    })
    expect(created.status).toBe(0)
    const worker = await titan.agent({ cwd: titan.folder({ name: 'request-scope' }) })
    await titan.owner({
      args: [
        'reply',
        'request-scope',
        '--text',
        'second turn',
      ],
    })
    await until({
      what: 'second worker turn',
      check: () => worker.answered >= 2,
    })
    await flushLogs()
    const recorded = lines()
    const start = recorded.find(line => line.operation === 'command.cli' && line.name === 'task create' && line.titanId === titan.id)
    const turns = recorded.filter(line => line.operation === 'turn.start' && line.titanId === titan.id)
    expect(start.requestId).toEqual(expect.any(String))
    expect(turns.length).toBeGreaterThanOrEqual(2)
    expect(turns.at(-1).requestId).not.toBe(start.requestId)
  },
)

test(
  'On mode suppresses successful git lookups and counts repeated failures per interval',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"on"}',
      ],
    })
    await until({
      what: 'the server applies On logging',
      check: () => logMode() === 'on',
    })
    await flushLogs()
    const start = lines().length
    const gitFolder = titan.folder({ name: 'git-probe' })
    await runProcess({
      command: 'git',
      args: ['init'],
      cwd: gitFolder,
    })
    await runProcess({
      command: 'git',
      args: [
        'rev-parse',
        '--git-dir',
      ],
      cwd: titan.folder({ name: 'git-probe' }),
    })
    await runProcess({
      command: 'git',
      args: [
        'symbolic-ref',
        'HEAD',
      ],
      cwd: titan.folder({ name: 'git-probe' }),
    })
    await runProcess({
      command: 'git',
      args: ['remote'],
      cwd: titan.folder({ name: 'git-probe' }),
    })
    await runProcess({
      command: 'git',
      args: [
        'rev-parse',
        '--invalid-option',
      ],
      cwd: '/nonexistent-synthetic-folder',
    })
    vi.useFakeTimers()

    try {
      const error = new Error('synthetic repeated failure')
      log({
        operation: 'repeat.probe',
        level: 'error',
        error,
      })
      log({
        operation: 'repeat.probe',
        level: 'error',
        error,
      })
      log({
        operation: 'repeat.probe',
        level: 'error',
        error,
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await flushLogs()
      const added = lines().slice(start)
      expect(added.filter(line => line.operation === 'exec' && line.name !== 'git init' && line.exitCode === 0)).toEqual([])
      expect(added.some(line => line.operation === 'exec' && line.exitCode !== 0)).toBe(true)
      expect(added.filter(line => line.operation === 'repeat.probe')).toHaveLength(2)
      expect(added.filter(line => line.operation === 'repeat.probe').map(line => line.repeatCount)).toEqual([
        undefined,
        2,
      ])
    } finally {
      vi.useRealTimers()
      flushRepeatedLines()
    }
  },
)

test(
  'performance includes agent and storage samples without operation rows',
  async () => {
    log({
      operation: 'process',
      heapUsed: 1048576,
      activeResources: 5,
    })
    log({
      operation: 'agent.memory',
      agents: [
        {
          titanId: 'synthetic',
          rss: 2097152,
        },
      ],
    })
    log({
      operation: 'storage',
      stateBytes: 4194304,
      logBytes: 5242880,
    })
    await flushLogs()
    const report = await performanceReport({
      since: Date.now() - 3600000,
      until: Date.now(),
      limit: 10,
    })
    expect(report.operations.some(row => [
      'storage',
      'agent.memory',
    ].includes(row.operation))).toBe(false)
    expect(report.memory).toContainEqual(expect.objectContaining({
      agentsMB: 2,
      stateMB: 4,
      logsMB: 5,
      activeResources: 5,
    }))
    const error = new Error('private\n    at private-stack-message')
    error.name = 'TimeoutError'
    const failure = logFailure({
      error: new AggregateError(
        [error],
        'private aggregate',
      ),
    })
    expect(failure.errors).toEqual([
      expect.objectContaining({
        name: 'TimeoutError',
        stack: expect.stringContaining('observability.test'),
      }),
    ])
    expect(JSON.stringify(failure)).not.toContain('private')
    const mismatched = new Error('safe header')
    mismatched.stack = 'Error: safe header but truncated\n    at private-custom-message'
    expect(logFailure({ error: mismatched }).stack).toBeUndefined()
  },
)

test(
  'resource sampling preserves unopened logs and ignores an in-flight listing after stop',
  async () => {
    const titan = await othrys.titan()
    const home = titan.folder({ name: 'stopped-sampler' })
    const result = await runProcess({
      command: process.execPath,
      args: [
        '--conditions=source',
        '--input-type=module',
        '-e',
        `
      import childProcess from 'node:child_process';
      import { promisify } from 'node:util';
      import { syncBuiltinESMExports } from 'node:module';
      import { setImmediate } from 'node:timers/promises';
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { openLogs, closeLogs, log, flushLogs } from '#app/diagnostics.ts';
      import { logFiles } from '#diagnostics/log-files.ts';

      let complete;
      let started;
      const listingStarted = new Promise(resolve => { started = resolve; });
      const original = childProcess.execFile;
      const listing = () => new Promise(resolve => {
        complete = () => resolve({ stdout: process.pid + ' 1 8192\\n' });
        started();
      });
      childProcess.execFile = (...args) => original(...args);
      childProcess.execFile[promisify.custom] = listing;
      syncBuiltinESMExports();
      // Import after installing the external process gate, before promisify captures execFile.
      const { startProcessLines } = await import('#diagnostics/process-line.ts');
      const { watchAgent } = await import('#workers/agent-memory.ts');
      const unserved = join(process.env.OTHRYS_HOME, 'titans', 'unserved');
      mkdirSync(unserved, { recursive: true });
      writeFileSync(join(unserved, 'titan.log'), '{"n":1');
      openLogs();
      watchAgent({ child: process, ids: { titanId: 'synthetic' } });
      const sampler = startProcessLines({ every: 1 });
      const LISTING_WAIT_MS = 10000;
      const timeout = setTimeout(() => { throw new Error('process listing did not start'); }, LISTING_WAIT_MS);
      await listingStarted;
      clearTimeout(timeout);
      sampler.stop();
      log({ operation: 'agent.memory', agents: [{ titanId: 'synthetic', rss: 2097152 }] });
      await flushLogs();
      complete();
      await setImmediate();
      await flushLogs();
      const memory = logFiles().flatMap(file => readFileSync(file.path, 'utf8').trim().split('\\n').map(JSON.parse))
        .filter(line => line.operation === 'agent.memory');
      console.log(JSON.stringify(memory));
      closeLogs();
      `,
      ],
      env: {
        ...process.env,
        OTHRYS_HOME: home,
      },
    })
    expect(
      result.status,
      result.stderr,
    ).toBe(0)
    expect(readFileSync(
      join(
        home,
        'titans',
        'unserved',
        'titan.log',
      ),
      'utf8',
    )).toBe('{"n":1')
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        agents: [
          {
            titanId: 'synthetic',
            rss: 2097152,
          },
        ],
      }),
    ])
  },
)

test(
  'a UTC rollover charges buffered earlier files before the next cleanup',
  async () => {
    const titan = await othrys.titan()
    const home = titan.folder({ name: 'rollover-logs' })
    const module = new URL(
      '../src/app/diagnostics.ts',
      import.meta.url,
    ).href
    const result = await runProcess({
      command: process.execPath,
      args: [
        '--conditions=source',
        '--input-type=module',
        '-e',
        `
      import { openLogs, closeLogs, writeLine, setLogBudget, flushLogs } from ${JSON.stringify(module)};
      openLogs();
      setLogBudget({ maxBytes: 4000 });
      for (let i = 0; i < 8; i++) {
        writeLine({ source: 'server', at: '2026-01-01T23:59:59.000Z',
          line: { operation: 'rollover', name: 'x'.repeat(200) } });
      }
      for (let i = 0; i < 20; i++) {
        writeLine({ source: 'server', at: '2026-01-02T00:00:00.000Z',
          line: { operation: 'rollover', name: 'x'.repeat(200) } });
      }
      await flushLogs();
      closeLogs();
    `,
      ],
      env: {
        ...process.env,
        OTHRYS_HOME: home,
      },
    })
    expect(result.status).toBe(0)
    const first = readFileSync(join(
      home,
      'logs',
      '2026-01-01.jsonl',
    ))
    const second = readFileSync(join(
      home,
      'logs',
      '2026-01-02.jsonl',
    ))
    expect(first.byteLength).toBeGreaterThan(0)
    expect(second.byteLength).toBeGreaterThan(0)
    expect(first.byteLength + second.byteLength).toBeLessThanOrEqual(4000)
  },
)

test(
  'a command naming its Titan with the legacy --titan flag is logged under that Titan',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"on"}',
      ],
    })
    await until({
      what: 'the server applies On logging',
      check: () => logMode() === 'on',
    })
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.OTHRYS_TITAN
    delete env.OTHRYS_ACTOR
    delete env.OTHRYS_TASK
    const run = await othrysCommand({
      args: [
        'titan',
        '--titan',
        titan.id,
        '--json',
      ],
      env,
    })
    expect(run.status).toBe(0)
    await until({
      what: 'the command line logged under the Titan it named',
      check: async () => {
        await flushLogs()

        return lines().some(line => line.operation === 'command.cli' && line.name === 'titan' && line.titanId === titan.id)
      },
    })
  },
)
