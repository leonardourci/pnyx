import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { compactionContext, historyBoundary } from './history.ts'
import { HYDRA_CARD } from './identity.ts'

const base = {
  v: 1 as const,
  actor: 'pnyx',
  cardId: HYDRA_CARD,
  at: '2026-11-05T00:00:00.000Z',
}

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
