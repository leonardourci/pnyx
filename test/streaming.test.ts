import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeProvider, type QueryFn } from '../src/workers/claude.ts'
import { liveReplies } from '../src/workers/streaming.ts'
import type { ThreadPage } from '../src/hydra/transcripts-read.ts'

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
          type: 'content_block_stop',
          index: 0,
        })
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
        5,
      ),
      [
        'working',
        {
          type: 'thinking',
          id: 'reply:0',
          running: true,
        },
        {
          type: 'thinking',
          id: 'reply:0',
          running: false,
        },
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
    assert.ok(events.every(e => typeof e === 'string' || [
      'reply:0',
      'reply:1',
    ].includes((e as { id: string }).id)))
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
