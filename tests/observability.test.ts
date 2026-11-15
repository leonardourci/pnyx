import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { flushLogs, log, setTodayFull } from '#app/diagnostics.ts'
import { logFiles } from '#diagnostics/log-files.ts'
import { startProcessLines } from '#diagnostics/process-line.ts'
import { startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
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
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"detailed"}',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })
    await hydra.owner({
      args: ['history'],
    })
    await fetch(`http://127.0.0.1:${pnyx.port()}/health?token=private-request-value`)
    const sample = startProcessLines({ every: 20 })

    try {
      await until({
        what: 'resource sample',
        check: async () => {
          await flushLogs()

          return lines().some(line => line.operation === 'process')
        },
      })
    } finally {
      sample.stop()
    }

    log({
      operation: 'privacy.probe',
      level: 'error',
      error: new Error(
        'private-owner-message token=secret',
        { cause: new Error('private-worker-message') },
      ),
    })
    await flushLogs()
    const recorded = lines()
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
        databaseBytes: expect.any(Number),
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
    const command = recorded.find(line => line.operation === 'command.cli' && line.name === 'task list')
    expect(command.correlationId).toEqual(expect.any(String))
    expect(recorded).toContainEqual(expect.objectContaining({
      operation: 'http.request',
      correlationId: command.correlationId,
    }))
    expect(JSON.stringify(recorded)).not.toMatch(/private-owner-message|private-worker-message|private-request-value/)
  },
)

test(
  'an error storm cannot grow the current log beyond its reserved failure budget',
  async () => {
    await flushLogs()
    const before = logFiles().reduce(
      (
        sum,
        file,
      ) => sum + file.bytes,
      0,
    )
    const budget = before + 1000
    setTodayFull({
      day: new Date().toISOString()
        .slice(
          0,
          10,
        ),
      full: false,
      maxBytes: budget,
    })

    try {
      for (let index = 0; index < 100; index += 1) {
        log({
          operation: 'failure.storm',
          level: 'error',
          error: new Error('synthetic failure'),
        })
      }

      await flushLogs()
      expect(logFiles().reduce(
        (
          sum,
          file,
        ) => sum + file.bytes,
        0,
      )).toBeLessThanOrEqual(budget * 2)
    } finally {
      setTodayFull({
        day: new Date().toISOString()
          .slice(
            0,
            10,
          ),
        full: false,
        maxBytes: 500 * 1024 * 1024,
      })
    }
  },
)
