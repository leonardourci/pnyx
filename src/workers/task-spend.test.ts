import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedUsage } from '../integrations/hooks/usage.ts'
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyHydra } from '../app/reducer.ts'
import type { HydraEvent } from '../app/model.ts'
import { spendFor, spendInputs, taskSpend } from './task-spend.ts'

const at = '2026-10-22T12:00:00Z'

test(
  'Claude usage keeps one final count for repeated chunks of the same message',
  () => {
    const records = [
      {
        type: 'assistant',
        timestamp: at,
        message: {
          id: 'm1',
          usage: {
            input_tokens: 20,
            output_tokens: 2,
            cache_read_input_tokens: 30,
          },
        },
      },
      {
        type: 'assistant',
        timestamp: at,
        message: {
          id: 'm1',
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            cache_read_input_tokens: 30,
          },
        },
      },
      {
        type: 'assistant',
        timestamp: at,
        message: {
          id: 'm2',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        },
      },
    ]
    assert.equal(
      recordedUsage({
        provider: 'claude-code',
        records,
      }).reduce(
        (
          total,
          row,
        ) => total + row.tokens,
        0,
      ),
      73,
    )
  },
)

test(
  'Codex cumulative counters count each delta once and include only recorded totals',
  () => {
    const count = ({ total }: { total: number }) => ({
      type: 'event_msg',
      timestamp: at,
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: total } },
      },
    })
    assert.deepEqual(
      recordedUsage({
        provider: 'codex',
        records: [
          count({ total: 100 }),
          count({ total: 100 }),
          count({ total: 160 }),
        ],
      }).map(row => row.tokens),
      [
        100,
        60,
      ],
    )
    assert.deepEqual(
      recordedUsage({
        provider: 'unknown',
        records: [count({ total: 10 })],
      }),
      [],
    )
  },
)

test(
  'task spend follows worker handoffs without charging the next task for earlier work',
  async () => {
    const {
      mkdtempSync,
      writeFileSync,
      rmSync,
    } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { emptyHydra } = await import('../app/reducer.ts')
    const { taskSpend } = await import('./task-spend.ts')
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-spend-test-',
    ))
    const path = join(
      dir,
      'transcript.jsonl',
    )
    const state = emptyHydra()
    const events: import('../app/model.ts').HydraEvent[] = [
      {
        v: 1,
        boardId: 'test',
        cardId: 'one',
        actor: 'hydra',
        id: 'attach',
        seq: 1,
        at: '2026-10-22T12:00:00Z',
        type: 'task.session',
        data: {
          session: 'worker',
          before: null,
          after: 'one',
        },
      },
      {
        v: 1,
        boardId: 'test',
        cardId: 'two',
        actor: 'hydra',
        id: 'next',
        seq: 2,
        at: '2026-10-22T13:00:00Z',
        type: 'task.session',
        data: {
          session: 'worker',
          before: 'one',
          after: 'two',
        },
      },
    ]
    state.sessions = {
      worker: {
        id: 'worker',
        originCardId: 'session',
        agent: {
          provider: 'claude',
          sessionId: 'worker',
          transcriptPath: path,
        },
        taskId: 'two',
        attention: [],
        sourceRefs: [],
      },
    }
    writeFileSync(
      path,
      [
        {
          type: 'assistant',
          timestamp: '2026-10-22T12:30:00Z',
          message: {
            id: 'first',
            usage: {
              input_tokens: 20,
              output_tokens: 5,
            },
          },
        },
        {
          type: 'assistant',
          timestamp: '2026-10-22T13:30:00Z',
          message: {
            id: 'second',
            usage: {
              input_tokens: 30,
              output_tokens: 10,
            },
          },
        },
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
    )

    try {
      assert.equal(
        taskSpend({
          state,
          events,
          task: 'one',
        }).worker,
        25,
      )
      assert.equal(
        taskSpend({
          state,
          events,
          task: 'two',
        }).worker,
        40,
      )
      assert.equal(
        taskSpend({
          state,
          events,
          task: 'absent',
        }).total,
        undefined,
      )
    } finally {
      rmSync(
        dir,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a growing transcript is counted from where it ended, and one pass gives each task its own total',
  () => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-spend-growth-',
    ))
    const transcript = join(
      dir,
      'worker.jsonl',
    )
    const record = ({
      id,
      at,
      tokens,
    }: {
      id: string
      at: string
      tokens: number
    }) => JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: {
        id,
        usage: { input_tokens: tokens },
      },
    })
    const state = emptyHydra()
    state.sessions = {
      worker: {
        id: 'worker',
        originCardId: 'worker',
        agent: {
          provider: 'claude-code',
          sessionId: 'worker',
          transcriptPath: transcript,
        },
        taskId: 'two',
        attention: [],
        sourceRefs: [],
      },
    }
    const events = [
      [
        '2026-10-22T10:00:00Z',
        null,
        'one',
      ],
      [
        '2026-10-22T11:00:00Z',
        'one',
        'two',
      ],
    ].map((
      [
        at,
        before,
        after,
      ],
      index,
    ) => ({
      v: 1,
      seq: index + 1,
      id: `assign-${index}`,
      at,
      actor: 'cli',
      cardId: after,
      type: 'task.session',
      data: {
        session: 'worker',
        before,
        after,
      },
    }) as HydraEvent)
    const count = () => spendFor({
      inputs: spendInputs({
        state,
        events,
        tasks: [
          'one',
          'two',
        ],
      }),
    })

    try {
      writeFileSync(
        transcript,
        `${record({
          id: 'a',
          at: '2026-10-22T10:30:00Z',
          tokens: 5,
        })}\n`,
      )
      assert.deepEqual(
        [
          count().one?.total,
          count().two?.total,
        ],
        [
          5,
          undefined,
        ],
      )

      const late = record({
        id: 'c',
        at: '2026-10-22T12:30:00Z',
        tokens: 100,
      })
      appendFileSync(
        transcript,
        `${record({
          id: 'b',
          at: '2026-10-22T11:30:00Z',
          tokens: 7,
        })}\n${late.slice(
          0,
          20,
        )}`,
      )
      assert.deepEqual(
        [
          count().one?.total,
          count().two?.total,
        ],
        [
          5,
          7,
        ],
      )

      appendFileSync(
        transcript,
        `${late.slice(20)}\n${record({
          id: 'b',
          at: '2026-10-22T11:30:00Z',
          tokens: 9,
        })}\n`,
      )
      const grown = count()
      assert.deepEqual(
        [
          grown.one?.total,
          grown.two?.total,
        ],
        [
          5,
          109,
        ],
      )
      assert.deepEqual(
        grown,
        {
          one: taskSpend({
            state,
            events,
            task: 'one',
          }),
          two: taskSpend({
            state,
            events,
            task: 'two',
          }),
        },
      )

      writeFileSync(
        transcript,
        `${record({
          id: 'a',
          at: '2026-10-22T10:30:00Z',
          tokens: 4,
        })}\n`,
      )
      assert.deepEqual(
        [
          count().one?.total,
          count().two?.total,
        ],
        [
          4,
          undefined,
        ],
      )
    } finally {
      rmSync(
        dir,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
