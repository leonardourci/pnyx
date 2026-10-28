import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '../../app/reducer.ts'
import { readStream } from '../../test-harness/streams.ts'
import type { HydraEvent } from '../../app/model.ts'
import { needsCommentNote } from './comments.ts'

test(
  'compaction replay preserves outcomes and rejects stale comment-teaching epochs',
  () => {
    let state = emptyHydra()

    for (const event of readStream({ name: 'lifecycle' }).slice(
      0,
      1,
    )) {
      state = reduce({
        state,
        event,
      })
    }

    const append = ({ data }: { data: unknown }) => {
      state = reduce({
        state,
        event: {
          v: 1,
          id: `compact-${state.seq + 1}`,
          seq: state.seq + 1,
          at: '2026-10-26T15:00:00Z',
          actor: 'pnyx',
          cardId: 'c1',
          type: 'session.compaction',
          data,
        } as HydraEvent,
      })
    }

    state.cards.c1!.agent = {
      provider: 'claude-code',
      sessionId: 's1',
    }

    append({
      data: {
        kind: 'status',
        operation: {
          id: 'summary',
          session: 'claude-code:s1',
          trigger: 'manual',
          state: 'running',
          startedAt: '2026-10-26T15:00:00Z',
        },
      },
    })
    append({
      data: {
        kind: 'status',
        operation: {
          id: 'summary',
          session: 'claude-code:s1',
          trigger: 'manual',
          state: 'done',
          startedAt: '2026-10-26T15:00:00Z',
          endedAt: '2026-10-26T15:00:42Z',
        },
      },
    })
    const compact = state.cards.c1!.compaction
    assert.equal(
      compact?.operations[0]?.state,
      'done',
    )
    assert.equal(
      compact?.commentEpoch,
      'summary',
    )
    append({
      data: {
        kind: 'comments',
        epoch: 'initial',
      },
    })
    assert.equal(
      state.cards.c1!.compaction?.taughtEpoch,
      undefined,
    )
    append({
      data: {
        kind: 'comments',
        epoch: 'claude-code:s1:summary',
      },
    })
    assert.equal(
      state.cards.c1!.compaction?.taughtEpoch,
      'claude-code:s1:summary',
    )
    append({
      data: {
        kind: 'status',
        operation: {
          id: 'summary',
          session: 'claude-code:s1',
          trigger: 'manual',
          state: 'running',
          startedAt: '2026-10-26T15:00:00Z',
        },
      },
    })
    assert.equal(
      state.cards.c1!.compaction?.operations[0]?.state,
      'done',
      'late starts cannot resurrect a terminal operation',
    )
    assert.equal(
      needsCommentNote({
        card: state.cards.c1!,
        text: '## Comments on your reply from today',
      }),
      false,
    )
    state.cards.c1!.agent = {
      provider: 'codex',
      sessionId: 'fresh',
    }
    assert.equal(
      needsCommentNote({
        card: state.cards.c1!,
        text: '## Comments on your reply from today',
      }),
      true,
    )
  },
)
