import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runForClient } from '#app/request-context.ts'
import { debug } from './cli.ts'
import { performanceReport } from './performance.ts'

test(
  'debug performance turns a window of one Hydra’s lines into counts, median, worst and total times, memory and the slowest actions first',
  async () => {
    const dir = join(
      process.env.PNYX_HOME!,
      'logs',
    )
    mkdirSync(
      dir,
      { recursive: true },
    )
    writeFileSync(
      join(
        dir,
        '2026-03-01.jsonl',
      ),
      `${[
        '{"v":1,"at":"2026-03-01T10:00:01.000Z","operation":"command.page","name":"task create","hydraId":"lab","ms":30}',
        '{"v":1,"at":"2026-03-01T10:00:02.000Z","operation":"command.page","name":"task create","hydraId":"lab","ms":10}',
        '{"v":1,"at":"2026-03-01T10:00:03.000Z","operation":"command.page","name":"task create","hydraId":"lab","ms":20}',
        '{"v":1,"at":"2026-03-01T10:00:04.000Z","operation":"turn.end","hydraId":"lab","taskId":"$hydra","ms":900}',
        '{"v":1,"at":"2026-03-01T10:00:05.000Z","operation":"command.page","name":"task create","hydraId":"other","ms":5000}',
        '{"v":1,"at":"2026-03-01T10:00:06.000Z","operation":"process","rss":104857600,"heapUsed":52428800,"cpuPercent":2,"loopDelayP99Ms":21}',
        '{"v":1,"at":"2026-03-01T10:00:07.000Z","level":"error","operation":"exec","name":"git fetch","ms":40}',
        '{"v":1,"at":"2026-03-01T10:00:08.000Z","level":"warn","operation":"logs.full","bytes":1048576}',
        '{"v":1,"at":"2026-03-01T11:30:00.000Z","operation":"command.page","name":"task create","hydraId":"lab","ms":99999}',
      ].join('\n')}\n`,
    )
    const report = await performanceReport({
      hydraId: 'lab',
      since: Date.parse('2026-03-01T10:00:00.000Z'),
      until: Date.parse('2026-03-01T11:00:00.000Z'),
      limit: 2,
    })
    assert.deepEqual(
      report.operations,
      [
        {
          operation: 'turn.end',
          count: 1,
          typicalMs: 900,
          worstMs: 900,
          totalMs: 900,
          errors: 0,
          warnings: 0,
        },
        {
          operation: 'command.page task create',
          count: 3,
          typicalMs: 20,
          worstMs: 30,
          totalMs: 60,
          errors: 0,
          warnings: 0,
        },
        {
          operation: 'exec git fetch',
          count: 1,
          typicalMs: 40,
          worstMs: 40,
          totalMs: 40,
          errors: 1,
          warnings: 0,
        },
        {
          operation: 'logs.full',
          count: 1,
          typicalMs: undefined,
          worstMs: undefined,
          totalMs: 0,
          errors: 0,
          warnings: 1,
        },
      ],
    )
    assert.deepEqual(
      report.slowest.map(row => [
        row.operation,
        row.ms,
      ]),
      [
        [
          'turn.end',
          900,
        ],
        [
          'exec git fetch',
          40,
        ],
      ],
    )
    assert.deepEqual(
      report.memory,
      [
        {
          at: '2026-03-01T10:00:06.000Z',
          rssMB: 100,
          heapMB: 50,
          cpuPercent: 2,
          loopDelayP99Ms: 21,
        },
      ],
    )
    assert.equal(
      report.lines,
      6,
    )
  },
)

test(
  'debug performance from a routine helper reads only its own Hydra, and anyone else every Hydra unless they name one',
  async () => {
    const dir = join(
      process.env.PNYX_HOME!,
      'logs',
    )
    mkdirSync(
      dir,
      { recursive: true },
    )
    writeFileSync(
      join(
        dir,
        '2026-03-02.jsonl',
      ),
      `${[
        '{"v":1,"at":"2026-03-02T10:00:01.000Z","operation":"command.cli","name":"task show","hydraId":"lab","ms":30}',
        '{"v":1,"at":"2026-03-02T10:00:02.000Z","operation":"command.cli","name":"task list","hydraId":"other","taskId":"secret-task","ms":50}',
        '{"v":1,"at":"2026-03-02T10:00:03.000Z","operation":"exec","name":"git fetch","ms":10}',
      ].join('\n')}\n`,
    )

    const operations = async ({ identity }: { identity: Record<string, string> }) => {
      // The command's answer type covers every debug subcommand; performance answers with its report.
      const view = await runForClient({
        identity,
        cwd: process.cwd(),
        run: () => debug([
          'performance',
          '--since',
          '2026-03-02T10:00:00.000Z',
          '--until',
          '2026-03-02T11:00:00.000Z',
        ]),
      }) as { operations: { operation: string }[] }

      return view.operations.map(row => row.operation)
    }

    assert.deepEqual(
      await operations({
        identity: {
          PNYX_ACTOR: 'helper:batch',
          PNYX_HYDRA: 'lab',
        },
      }),
      [
        'command.cli task show',
        'exec git fetch',
      ],
    )
    assert.deepEqual(
      await operations({ identity: { PNYX_HYDRA: 'lab' } }),
      [
        'command.cli task list',
        'command.cli task show',
        'exec git fetch',
      ],
    )
  },
)
