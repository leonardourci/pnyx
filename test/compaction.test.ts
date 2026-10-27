import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
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

for (const refuse of [
  false,
  true,
]) {
  test(
    `Codex cancellation before the compact turn is announced ${refuse ? 'reports a rejected interrupt' : 'waits for native confirmation'}`,
    { timeout: 10_000 },
    async () => {
      const root = mkdtempSync(join(
        tmpdir(),
        'pnyx-early-stop-',
      ))
      const fixture = fakeCodex({
        root,
        compact: 'hold-start',
        refuse: refuse ? 'interrupt' : undefined,
      })
      let ready = () => {}
      const announced = new Promise<void>(resolve => ready = resolve)
      const session = await codexProvider({
        spawnCodex: ({
          cwd,
          env,
        }) => {
          const child = fixture.spawnCodex({
            cwd,
            env,
          })
          let output = ''
          child.stdout.on(
            'data',
            data => {
              output += String(data)

              if (output.includes('fixture/compact-ready')) {
                ready()
              }
            },
          )

          return child
        },
      }).open({
        cwd: root,
        settings: {},
        env: { PNYX_HOME: root },
        signal: new AbortController().signal,
      })
      const events: HostedEvent[] = []
      const running = (async () => {
        for await (const event of session.run({
          input: (async function* () {
            yield '/compact'
          })(),
          permission: async () => ({ behavior: 'allow' }),
        })) {
          events.push(event)
        }
      })()
      const drained = running.catch(() => {})

      try {
        await announced
        const cancelled = session.interrupt().then(
          () => 'stopped',
          (error: Error) => error.message,
        )
        fixture.children[0]!.kill('SIGUSR1')
        assert.equal(
          await cancelled,
          refuse ? 'fixture refused interrupt' : 'stopped',
        )
        const interrupt = fixture.messages().find(message => message.method === 'turn/interrupt')
        assert.equal(
          interrupt?.params?.turnId,
          'turn-1',
        )

        if (refuse) {
          assert.equal(
            events.some(event => typeof event !== 'string' && event.type === 'compaction' && event.state !== 'running'),
            false,
          )
          fixture.children[0]!.kill('SIGUSR1')
        }

        await running
        assert.equal(
          events.filter(event => typeof event !== 'string' && event.type === 'compaction').at(-1)?.state,
          refuse ? 'done' : 'cancelled',
        )
      } finally {
        session.close()
        await drained
        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      }
    },
  )
}

async function collect({ events }: { events: AsyncIterable<HostedEvent> }) {
  const result: HostedEvent[] = []

  for await (const event of events) {
    result.push(event)
  }

  return result
}

test(
  'Claude native compact stays bare on a fresh Hydra and emits one durable outcome',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-compact-',
    ))
    const received: string[] = []
    const query = (({ prompt }: Parameters<QueryFn>[0]) => Object.assign(
      (async function* () {
        for await (const message of prompt as AsyncIterable<{ message: { content: string } }>) {
          received.push(message.message.content)
          yield {
            type: 'system',
            subtype: 'status',
            status: 'compacting',
            uuid: 'compact-start',
          }
          yield {
            type: 'system',
            subtype: 'status',
            status: null,
            compact_result: 'success',
          }
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'manual' },
          }
          yield {
            type: 'result',
            is_error: false,
          }
        }
      })(),
      { close() {} },
    )) as unknown as QueryFn

    try {
      const session = await claudeProvider({ query }).open({
        cwd: root,
        settings: {},
        env: { CLAUDE_CONFIG_DIR: root },
        signal: new AbortController().signal,
        context: () => '<pnyx-digest>current</pnyx-digest>',
      })
      const events = await collect({
        events: session.run({
          input: (async function* () {
            yield '/compact'
          })(),
          permission: async () => ({ behavior: 'allow' }),
        }),
      })
      assert.deepEqual(
        received,
        ['/compact'],
      )
      assert.deepEqual(
        events.filter(event => typeof event !== 'string' && event.type === 'compaction'),
        [
          {
            type: 'compaction',
            id: 'compact-start',
            state: 'running',
            trigger: 'manual',
          },
          {
            type: 'compaction',
            id: 'compact-start',
            state: 'done',
            trigger: 'manual',
          },
        ],
      )
      session.close()
    } finally {
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
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

test(
  'Codex dispatches compact through its native RPC and reports its item lifecycle',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-compact-',
    ))
    const fixture = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: { PNYX_HOME: root },
      signal: new AbortController().signal,
    })

    try {
      const events = await collect({
        events: session.run({
          input: (async function* () {
            yield '/compact'
          })(),
          permission: async () => ({ behavior: 'allow' }),
        }),
      })
      assert.ok(fixture.messages().some(message => message.method === 'thread/compact/start'))
      assert.equal(
        fixture.messages().some(message => message.method === 'turn/start'),
        false,
      )
      assert.equal(
        fixture.messages().some(message => message.method === 'turn/interrupt'),
        false,
      )
      assert.deepEqual(
        events.filter((event: HostedEvent) => typeof event !== 'string' && event.type === 'compaction'),
        [
          {
            type: 'compaction',
            id: 'compact-item',
            trigger: 'manual',
            state: 'running',
          },
          {
            type: 'compaction',
            id: 'compact-item',
            trigger: 'manual',
            state: 'done',
          },
        ],
      )
    } finally {
      session.close()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Codex compact failure is confirmed by the final turn even after item completion',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-compact-fail-',
    ))
    const fixture = fakeCodex({
      root,
      compact: 'fail',
    })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: { PNYX_HOME: root },
      signal: new AbortController().signal,
    })

    try {
      const events = await collect({
        events: session.run({
          input: (async function* () {
            yield '/compact'; yield 'Continue after failure'
          })(),
          permission: async () => ({ behavior: 'allow' }),
        }),
      })
      const outcomes = events.filter(event => typeof event !== 'string' && event.type === 'compaction')
      assert.equal(
        outcomes.length,
        2,
      )
      assert.equal(
        (outcomes[1] as { state: string }).state,
        'failed',
      )
      assert.ok(fixture.messages().some(message => message.method === 'turn/start'))
      assert.equal(
        fixture.messages().some(message => message.method === 'turn/steer'),
        false,
      )
    } finally {
      session.close()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
