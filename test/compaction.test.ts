import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HostedEvent } from '../src/server/provider.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'
import { readStream } from './streams.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { codexProvider } from '../src/server/codex.ts'
import { fakeCodex } from './codex-fixture.ts'
import { needsCommentNote } from '../src/compaction/comments.ts'

test(
  'Codex cancellation progresses while its compact event consumer is paused',
  { timeout: 10_000 },
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-paused-compact-',
    ))
    const fixture = fakeCodex({
      root,
      compact: 'hold-start',
    })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: { PNYX_HOME: root },
      signal: new AbortController().signal,
    })
    t.after(() => session.close())
    const events = session.run({
      input: (async function* () {
        yield '/compact'
      })(),
      permission: async () => ({ behavior: 'allow' }),
    })[Symbol.asyncIterator]()
    assert.equal(
      (await events.next()).value,
      'working',
    )
    const cancelled = session.interrupt()
    fixture.children[0]!.kill('SIGUSR1')
    await cancelled
    const observed: HostedEvent[] = []

    for (let event = await events.next(); !event.done; event = await events.next()) {
      observed.push(event.value)
    }

    assert.ok(observed.some(event => typeof event !== 'string'
      && event.type === 'compaction' && event.state === 'cancelled'))
    assert.equal(
      observed.at(-1),
      'finished',
    )
  },
)

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
