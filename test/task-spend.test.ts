import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedUsage } from '../src/integrations/hooks/usage.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyHydra } from '../src/core/reducer.ts'
import { hydraConfig } from '../src/core/hydra.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { taskSpend } from '../src/spend/tasks.ts'

const at = '2026-10-22T12:00:00Z'

test(
  'task totals retain earlier Hydra sessions after a replacement starts',
  () => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-spend-',
    ))
    const state = emptyHydra()
    const events: HydraEvent[] = []
    state.sessions = {}

    try {
      for (const [
        index,
        tokens,
      ] of [
          15,
          20,
        ].entries()) {
        const session = `hydra-${index}`
        const at = `2026-10-22T1${index}:00:00Z`
        const transcript = join(
          dir,
          `${session}.jsonl`,
        )
        writeFileSync(
          transcript,
          [
            {
              type: 'user',
              message: { content: '<pnyx-report task="one">A report</pnyx-report>' },
            },
            {
              type: 'assistant',
              timestamp: at,
              message: {
                id: session,
                usage: { input_tokens: tokens },
              },
            },
          ].map(record => JSON.stringify(record)).join('\n') + '\n',
        )
        const config = hydraConfig({ state })
        config.hydra.session = session
        state.config = config
        state.sessions[session] = {
          id: session,
          originCardId: session,
          agent: {
            provider: 'claude-code',
            sessionId: session,
            transcriptPath: transcript,
          },
          taskId: null,
          attention: [],
          sourceRefs: [],
        }
        events.push({
          v: 1,
          seq: index + 1,
          id: session,
          at,
          actor: 'cli',
          cardId: '$board',
          type: 'board.configured',
          data: structuredClone(config),
        })
      }

      assert.equal(
        taskSpend({
          state,
          events,
          task: 'one',
        }).hydra,
        35,
      )
      assert.equal(
        taskSpend({
          state,
          events,
          task: 'one',
        }).total,
        35,
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
  'Hydra usage carries explicit task context, clearing it on an unrelated owner message',
  () => {
    const usage = ({ id }: { id: string }) => ({
      type: 'assistant',
      timestamp: at,
      message: {
        id,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    })
    const records = [
      {
        type: 'user',
        message: { content: '<pnyx-report task="task-one">Result</pnyx-report>' },
      },
      usage({ id: 'm1' }),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: 'Hello',
            },
          ],
        },
      },
      usage({ id: 'm2' }),
    ]
    assert.deepEqual(
      recordedUsage({
        provider: 'claude',
        records,
      }).map(row => row.tasks),
      [
        ['task-one'],
        [],
      ],
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
    const { emptyHydra } = await import('../src/core/reducer.ts')
    const { taskSpend } = await import('../src/spend/tasks.ts')
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-spend-test-',
    ))
    const path = join(
      dir,
      'transcript.jsonl',
    )
    const state = emptyHydra()
    const events: import('../src/core/model.ts').HydraEvent[] = [
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
