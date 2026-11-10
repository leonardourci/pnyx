import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
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
        },
        {
          operation: 'command.page task create',
          count: 3,
          typicalMs: 20,
          worstMs: 30,
          totalMs: 60,
          errors: 0,
        },
        {
          operation: 'exec git fetch',
          count: 1,
          typicalMs: 40,
          worstMs: 40,
          totalMs: 40,
          errors: 1,
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
      5,
    )
  },
)
