import { needsRecentThread } from '#hydra/thread-history.ts'
import { receiveConversation, loadEarlierMessages } from './conversation-history.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { receivedThread } from '#hydra/thread-delta.ts'

const page = ({
  stream,
  version,
}: {
  stream: string
  version: number
}): ThreadPage => ({
  card: '$hydra',
  session: 'fixture',
  stream,
  version,
  entries: [],
  route: true,
  watching: 'unknown',
  conversation: {
    through: 1,
    entries: [],
    timings: {},
    folds: {},
    trailing: {},
  },
})

test(
  'an older response cannot replace a newer server conversation, and a reconnect can',
  async () => {
    const newer = page({
      stream: 'connection-1',
      version: 3,
    })
    assert.equal(
      receivedThread({
        before: newer,
        latest: page({
          stream: 'connection-1',
          version: 2,
        }),
      }),
      newer,
    )
    const reconnected = page({
      stream: 'connection-2',
      version: 1,
    })
    assert.equal(
      receivedThread({
        before: newer,
        latest: reconnected,
      }),
      reconnected,
    )
    const old = {
      id: '0:m0.0',
      messageId: '0:m0',
      kind: 'message' as const,
      role: 'assistant',
      text: 'An old passage',
    }
    const latest = {
      id: '100:m0',
      kind: 'message' as const,
      role: 'assistant',
      text: 'A recent passage',
    }
    const reading = {
      ...newer,
      entries: [
        old,
        latest,
      ],
    }
    const trimmed = {
      ...newer,
      version: 4,
      recent: true,
      entries: [latest],
      older: 'older',
    }
    assert.equal(
      receiveConversation({
        before: reading,
        latest: trimmed,
        reading: true,
      }),
      reading,
    )
    assert.equal(
      receiveConversation({
        before: reading,
        latest: trimmed,
        reading: false,
      }),
      trimmed,
    )
    const restored = {
      ...reading,
      version: 5,
      recent: false,
    }
    assert.equal(
      receiveConversation({
        before: reading,
        latest: restored,
        reading: true,
      }),
      restored,
    )
    const commentPage = await loadEarlierMessages({
      past: trimmed,
      cursor: 'older',
      message: old.messageId,
      load: async () => ({
        ...restored,
        entries: [old],
        older: undefined,
      }),
    })
    assert.deepEqual(
      commentPage?.entries.map(entry => entry.id),
      [
        '0:m0.0',
        '100:m0',
      ],
    )
    const longReply: ThreadPage = {
      ...trimmed,
      pages: 3,
      entries: Array.from(
        { length: 200 },
        (
          _,
          index,
        ) => ({
          ...latest,
          id: `long.${index}`,
          messageId: 'long',
        }),
      ),
    }
    assert.equal(
      needsRecentThread({ page: longReply }),
      false,
    )
    assert.equal(
      needsRecentThread({
        page: {
          ...longReply,
          recent: false,
        },
      }),
      true,
    )
  },
)
