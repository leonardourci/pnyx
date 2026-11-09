import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { compactionContext, historyBoundary, joinMessageParts, readHistory } from './history.ts'
import { HYDRA_CARD } from './identity.ts'
import { recordEntries } from './transcripts-read.ts'

const base = {
  v: 1 as const,
  actor: 'pnyx',
  cardId: HYDRA_CARD,
  at: '2026-11-05T00:00:00.000Z',
}

test(
  'pinned history recovers task intents and meaningful helper outcomes once, without repeated waits',
  () => {
    const events: HydraEvent[] = [
      {
        ...base,
        id: 'created',
        seq: 1,
        cardId: 'task-a',
        type: 'task.created',
        data: {
          key: 'a',
          title: 'Example',
          intent: 'Keep export records.',
        },
      },
      {
        ...base,
        id: 'revised',
        seq: 2,
        cardId: 'task-a',
        type: 'task.brief',
        data: {
          before: '',
          after: '',
          intent: 'Keep archived export records.',
        },
      },
      {
        ...base,
        id: 'helper-results',
        seq: 3,
        type: 'hydra.helper-finished',
        data: {
          batch: 'results',
          outcomes: [
            {
              task: 'task-a',
              status: 'handled',
              summary: 'Export is ready: https://example.test/result',
            },
            {
              task: 'task-b',
              status: 'needs_main',
              summary: 'Choose an archive format. sk-abcdefghijklmnop1234',
            },
            {
              task: 'task-c',
              status: 'still_waiting',
              summary: 'Same wait as before.',
            },
          ],
        },
      },
      {
        ...base,
        id: 'automated-result',
        seq: 4,
        type: 'hydra.message',
        data: {
          hydra: 'hydra',
          action: 'send',
          kind: 'routine',
          text: 'Export is ready: https://example.test/result',
        },
      },
      {
        ...base,
        id: 'legacy-results',
        seq: 5,
        type: 'hydra.helper-finished',
        data: {
          batch: 'legacy',
          outcomes: [
            {
              task: 'task-a',
              audience: 'routine',
              summary: 'Earlier archive was validated.',
            },
            {
              task: 'task-b',
              audience: 'owner',
              summary: 'Earlier format decision is needed.',
            },
          ],
        },
      },
    ]
    const state = replay({
      state: emptyHydra(),
      events,
    })
    const first = readHistory({
      state,
      events,
      since: 'origin',
      through: 3,
      budget: 1,
    })
    assert.equal(
      first.text,
      '[task:task-a task created] Keep export records.',
    )
    const second = readHistory({
      state,
      events,
      since: 'origin',
      after: first.after,
      budget: 1,
    })
    assert.equal(
      second.text,
      '[task:task-a brief] Keep archived export records.',
    )
    const third = readHistory({
      state,
      events,
      since: 'origin',
      after: second.after,
      budget: 1,
    })
    assert.equal(
      third.text,
      '[helper:task-a handled] Export is ready: https://example.test/result',
    )
    assert.equal(
      third.more,
      true,
    )
    const last = readHistory({
      state,
      events,
      since: 'origin',
      after: third.after,
      budget: 1,
    })
    assert.equal(
      last.text,
      '[helper:task-b needs_main] Choose an archive format. [redacted]',
    )
    assert.equal(
      last.more,
      false,
    )
    assert.equal(
      last.snapshot,
      3,
    )
    const all = readHistory({
      state,
      events,
      since: 'origin',
    })
    assert.equal(
      all.text,
      [
        '[task:task-a task created] Keep export records.',
        '[task:task-a brief] Keep archived export records.',
        '[helper:task-a handled] Export is ready: https://example.test/result',
        '[helper:task-b needs_main] Choose an archive format. [redacted]',
        '[helper:task-a routine] Earlier archive was validated.',
        '[helper:task-b owner] Earlier format decision is needed.',
      ].join('\n\n'),
    )
  },
)

test(
  'legacy switch summaries bind to the matching operation when a native milestone finishes first',
  () => {
    const events: HydraEvent[] = [
      {
        ...base,
        id: 'legacy-start',
        seq: 1,
        type: 'hydra.operation',
        data: {
          id: 'agent-change:owner:legacy',
          kind: 'compaction',
          state: 'started',
          through: 0,
        },
      },
      {
        ...base,
        id: 'native-start',
        seq: 2,
        type: 'session.compaction',
        data: {
          kind: 'status',
          operation: {
            id: 'native',
            session: 'claude-code:legacy',
            trigger: 'auto',
            state: 'running',
            startedAt: base.at,
          },
        },
      },
      {
        ...base,
        id: 'native-finish',
        seq: 3,
        type: 'session.compaction',
        data: {
          kind: 'status',
          operation: {
            id: 'native',
            session: 'claude-code:legacy',
            trigger: 'auto',
            state: 'done',
            startedAt: base.at,
            endedAt: base.at,
          },
        },
      },
      {
        ...base,
        id: 'legacy-change',
        seq: 4,
        type: 'hydra.agent-change',
        data: {
          id: 'owner',
          previous: {
            harness: 'claude',
            model: 'sonnet',
          },
          next: {
            harness: 'codex',
            model: 'codex',
          },
          kind: 'agent',
          state: 'finished',
          summary: 'The switch covered the original snapshot.',
        },
      },
      {
        ...base,
        id: 'legacy-finish',
        seq: 5,
        type: 'hydra.operation',
        data: {
          id: 'agent-change:owner:legacy',
          kind: 'compaction',
          state: 'finished',
        },
      },
    ]
    const state = replay({
      state: emptyHydra(),
      events,
    })
    assert.deepEqual(
      compactionContext({ state }),
      {
        since: 'agent-change:owner:legacy',
        summary: 'The switch covered the original snapshot.',
      },
    )
    assert.equal(
      historyBoundary({
        state,
        since: 'last-compaction',
      }),
      0,
    )
    assert.equal(
      state.historyMilestones?.find(item => item.id === 'native')?.summary,
      undefined,
    )
  },
)

test(
  'Markdown messages split for transport reassemble across older pages without losing text',
  () => {
    const text = '# Plan\n\n```typescript\n' + 'const ready = true;\n'.repeat(130) + '```\n\nFinal paragraph.'
    const entries = recordEntries({
      record: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        },
      },
      offset: 42,
    })
    assert.ok(entries.length > 2)
    const latest = joinMessageParts({ entries: entries.slice(1) })
    assert.equal(
      latest.length,
      1,
    )
    assert.ok(latest[0].part! > 0)
    const all = joinMessageParts({ entries })
    assert.equal(
      all.length,
      1,
    )
    assert.equal(
      all[0].text,
      text,
    )
    assert.equal(
      all[0].messageId,
      '42:m0',
    )
    assert.equal(
      all[0].role,
      'assistant',
    )
    assert.equal(
      joinMessageParts({
        entries: [
          entries[0],
          entries[2],
        ],
      }).length,
      2,
      'never bridge a missing part',
    )
    assert.equal(
      joinMessageParts({
        entries: [
          ...entries,
          {
            ...entries[0],
            messageId: 'different',
          },
        ],
      }).length,
      2,
    )
  },
)

test(
  'compaction history excludes assistant-prefixed traces while retaining legacy messages',
  () => {
    const events: HydraEvent[] = [
      {
        ...base,
        seq: 1,
        id: 'reply',
        type: 'chat.message',
        data: {
          session: 'fixture',
          nativeId: '0:m0',
          role: 'assistant',
          text: 'The release is ready.',
        },
      },
      {
        ...base,
        seq: 2,
        id: 'tool',
        type: 'chat.message',
        data: {
          session: 'fixture',
          nativeId: '100:t0',
          role: 'assistant_tool',
          kind: 'tool',
          text: 'Raw tool output.',
        },
      },
      {
        ...base,
        seq: 3,
        id: 'thinking',
        type: 'chat.message',
        data: {
          session: 'fixture',
          nativeId: '200:t0',
          role: 'assistant_thinking',
          kind: 'thinking',
          text: 'Private reasoning.',
        },
      },
    ]
    const history = readHistory({
      state: replay({
        state: emptyHydra(),
        events,
      }),
      events,
      since: 'origin',
    })
    assert.equal(
      history.text,
      '[Hydra] The release is ready.',
    )
  },
)
