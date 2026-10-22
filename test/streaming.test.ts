import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import { fakeCodex } from './codex-fixture.ts'
import { liveReplies } from '../src/server/streaming.ts'
import type { ThreadPage } from '../src/thread/read.ts'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { commands } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { startServer, type ServerMessage } from '../src/server/server.ts'
import { localToken } from '../src/server/state.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { HYDRA_CARD } from '../src/core/hydra.ts'

test(
  'Claude forwards text before the result under one id per block, excluding thinking and nested agent output',
  async () => {
    const stream = ({ ...event }: Record<string, unknown>) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event,
    })
    const delta = ({ text }: { text: string }) => stream({
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'text_delta',
        text,
      },
    })
    // The SDK repeats each finished block as its own assistant message, always at index 0.
    const query = (({ options }) => {
      assert.equal(
        options?.includePartialMessages,
        true,
      )

      return (async function* () {
        yield {
          ...stream({
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'Hidden',
            },
          }),
          parent_tool_use_id: 'child',
        }
        yield stream({
          type: 'message_start',
          message: { id: 'reply' },
        })
        yield stream({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        })
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'reply',
            content: [
              {
                type: 'thinking',
                thinking: 'Plan',
              },
            ],
          },
        }
        yield stream({
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'text',
            text: '',
          },
        })
        yield delta({ text: 'Hello' })
        yield delta({ text: ' world' })
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'reply',
            content: [
              {
                type: 'text',
                text: 'Hello world',
              },
            ],
          },
        }
        yield {
          type: 'result',
          is_error: false,
        }
      })()
    }) as QueryFn
    const session = await claudeProvider({ query }).open({
      cwd: '/tmp',
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const live = liveReplies()
    live.start({ offset: 0 })
    const events: unknown[] = []

    for await (const event of session.run({
      input: (async function* () {
        yield 'Hi'
      })(),
      permission: async () => ({
        behavior: 'deny',
        message: 'unused',
      }),
    })) {
      events.push(event)

      if (typeof event !== 'string' && event.type === 'text') {
        live.update(event)
      }
    }

    assert.deepEqual(
      events.slice(
        0,
        3,
      ),
      [
        'working',
        {
          type: 'text',
          id: 'reply:1',
          text: 'Hello',
          append: true,
        },
        {
          type: 'text',
          id: 'reply:1',
          text: ' world',
          append: true,
        },
      ],
    )
    assert.equal(
      events.at(-1),
      'finished',
    )
    assert.ok(events.every(e => typeof e === 'string' || (e as { id: string }).id === 'reply:1'))
    assert.deepEqual(
      live.page({
        page: {
          card: 'hydra',
          entries: [],
          route: true,
          watching: 'unknown',
        },
      }).entries.map(e => e.text),
      ['Hello world'],
    )
  },
)

test(
  'a stopped Codex turn finishes cleanly and the next turn reports its own context use',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stream-',
    ))
    const fixture = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      env: {},
      settings: {},
      signal: new AbortController().signal,
    })
    const events = session.run({
      input: (async function* () {
        yield 'HOLD'
        yield 'USAGE'
      })(),
      permission: async () => ({
        behavior: 'deny',
        message: 'unused',
      }),
    })[Symbol.asyncIterator]()

    try {
      assert.equal(
        (await events.next()).value,
        'working',
      )
      await session.interrupt()
      assert.equal(
        (await events.next()).value,
        'finished',
      )
      assert.deepEqual(
        fixture.messages().find(message => message.method === 'turn/interrupt')?.params,
        {
          threadId: session.id,
          turnId: 'turn-1',
        },
      )
      const next: unknown[] = []

      for (let event = await events.next(); event.value !== 'finished'; event = await events.next()) {
        next.push(event.value)
      }

      assert.deepEqual(
        next,
        [
          'working',
          {
            type: 'usage',
            used: 5_000,
            window: 258_000,
          },
          {
            type: 'usage',
            limits: [
              {
                label: 'session',
                used: 12,
              },
            ],
          },
        ],
      )
    } finally {
      session.close()
    }
  },
)

test(
  'Codex exposes native deltas before a held turn completes and ignores other threads',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stream-',
    ))
    const fixture = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      env: {},
      settings: {},
      signal: new AbortController().signal,
    })
    const events = session.run({
      input: (async function* () {
        yield 'STREAM'
      })(),
      permission: async () => ({
        behavior: 'deny',
        message: 'unused',
      }),
    })[Symbol.asyncIterator]()

    try {
      assert.equal(
        (await events.next()).value,
        'working',
      )
      assert.deepEqual(
        (await events.next()).value,
        {
          type: 'text',
          id: 'answer',
          text: 'Hello',
          append: true,
        },
      )
      assert.deepEqual(
        (await events.next()).value,
        {
          type: 'text',
          id: 'answer',
          text: ' world',
          append: true,
        },
      )
      assert.equal(
        fixture.children[0]?.exitCode,
        null,
      )
      fixture.children[0]!.kill('SIGUSR1')
      assert.equal(
        (await events.next()).value,
        'finished',
      )
    } finally {
      session.close()
    }
  },
)

test(
  'live replies reconcile with saved chunks without duplicating earlier identical replies',
  () => {
    const stream = liveReplies()
    stream.start({ offset: 100 })
    stream.update({
      id: 'reply',
      text: 'Hello',
      append: true,
    })
    const page: ThreadPage = {
      card: 'task',
      entries: [
        {
          id: '0:m0',
          role: 'assistant',
          kind: 'message',
          text: 'Hello world',
        },
      ],
      route: true,
      watching: 'unknown',
    }
    assert.equal(
      stream.page({ page }).entries.at(-1)?.text,
      'Hello',
    )
    stream.update({
      id: 'reply',
      text: ' world',
      append: true,
    })
    const saved: ThreadPage = {
      ...page,
      entries: [
        ...page.entries,
        {
          id: '101:m0',
          messageId: '101:m0',
          part: 0,
          role: 'assistant',
          kind: 'message',
          text: 'Hello ',
        },
        {
          id: '101:m0.6',
          messageId: '101:m0',
          part: 6,
          role: 'assistant · continued',
          kind: 'message',
          text: 'world',
        },
      ],
    }
    const reconciled = stream.page({ page: saved })
    assert.equal(
      reconciled.entries.filter(e => e.streaming).length,
      0,
    )
    assert.equal(
      reconciled.entries.length,
      3,
    )
    stream.finish()
    assert.equal(
      stream.page({ page: saved }).entries.length,
      3,
    )
    stream.start({ offset: 200 })
    assert.equal(
      stream.page({ page }).entries.length,
      1,
    )
  },
)

test(
  'Hydra and task subscriptions show live replies, reconnect during a turn and settle to saved history',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stream-socket-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    process.env.CLAUDE_CONFIG_DIR = join(
      root,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    fakeDispatch({ root })
    await commands.hydra([
      'create',
      'stream',
      '--hydra',
      'stream',
    ])
    await commands.task([
      'create',
      '--key',
      'test',
      '--title',
      'Stream test',
      '--folder',
      root,
      '--hydra',
      'stream',
    ])
    await commands.task([
      'brief',
      'test',
      '--brief',
      'Reply to me',
      '--hydra',
      'stream',
    ])
    const sdk = hydraSdk()
    sdk.control.stream = true
    const server = await startServer({
      hydraId: 'stream',
      query: sdk.query,
    })
    const tabs: WebSocket[] = []
    const state = () => loadHydra({ hydraId: 'stream' }).state

    const waitFor = async ({ check }: { check(): boolean }) => {
      for (let i = 0; i < 300; i++) {
        if (check()) {
          return
        }

        await new Promise(resolve => setTimeout(
          resolve,
          10,
        ))
      }

      assert.fail('stream subscription timed out')
    }

    const subscribe = async ({ card }: { card: string }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/stream/ws?token=${localToken()}`)
      tabs.push(ws)
      const pages: ThreadPage[] = []
      ws.on(
        'message',
        data => {
          const message = JSON.parse(String(data)) as ServerMessage

          if (message.type === 'thread' && message.thread.card === card) {
            pages.push(message.thread)
          }

          if (message.type === 'receipt' && message.thread) {
            pages.push(message.thread as ThreadPage)
          }
        },
      )
      await once(
        ws,
        'open',
      )
      ws.send(JSON.stringify({
        type: 'command',
        id: 'subscribe',
        name: 'thread',
        args: [card],
      }))
      await waitFor({ check: () => pages.length > 0 })

      return pages
    }

    try {
      for (const target of [
        'hydra',
        'task',
      ]) {
        sdk.control.hold = true
        const card = target === 'hydra' ? HYDRA_CARD : state().keys.test!

        if (target === 'hydra') {
          await commands.hydra([
            'send',
            '--text',
            'Hello streaming',
            '--hydra',
            'stream',
          ])
        } else {
          await startTask({
            hydraId: 'stream',
            task: card,
            meta: {
              actor: 'test',
              at: new Date().toISOString(),
              id: 'stream-start',
            },
          })
        }

        await waitFor({
          check: () => !!state().cards[card]?.agent,
        })
        const pages = await subscribe({ card })
        await waitFor({
          check: () => pages.some(p => p.entries.some(
            e => e.streaming && e.text.startsWith('Hydra: ') && e.text.length === 8,
          )),
        })
        assert.equal(
          state().cards[card]?.sessionActivity,
          'working',
        )
        const reconnected = await subscribe({ card })
        assert.ok(reconnected.at(-1)?.entries.some(e => e.streaming))
        let overlap: ThreadPage[] | undefined

        if (target === 'task') {
          await commands.hydra([
            'send',
            '--text',
            'Overlap the worker turn',
            '--hydra',
            'stream',
          ])
          overlap = await subscribe({ card: HYDRA_CARD })
          await waitFor({
            check: () => overlap?.at(-1)?.entries.some(
              e => e.streaming && e.text === 'Hydra: O',
            ) ?? false,
          })
        }

        sdk.release()
        await waitFor({
          check: () => pages.at(-1)?.entries.some(
            e => e.role === 'assistant' && !e.streaming && e.text.startsWith('Hydra: '),
          ) ?? false,
        })
        assert.equal(
          pages.at(-1)?.entries.filter(e => e.role === 'assistant' && e.text.startsWith('Hydra: ')).length,
          1,
        )

        if (overlap) {
          await waitFor({
            check: () => overlap.at(-1)?.entries.some(
              e => !e.streaming && e.text === 'Hydra: Overlap the worker turn',
            ) ?? false,
          })
        }
      }
    } finally {
      sdk.release()
      tabs.forEach(ws => ws.terminate())
      await server.close()
    }
  },
)
