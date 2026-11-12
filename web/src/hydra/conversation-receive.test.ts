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
  () => {
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
  },
)
