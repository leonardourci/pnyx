import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatFollow } from './chat-follow.ts'

const tracked = () => {
  const reports: boolean[] = []
  const follow = createChatFollow({ changed: ({ away }) => reports.push(away) })

  return {
    follow,
    reports,
  }
}

test(
  'expanding a row stops following and reports the chat away, so the trim and the receive agree',
  () => {
    const {
      follow,
      reports,
    } = tracked()
    follow.expand({ at: 0 })
    assert.equal(
      follow.following(),
      false,
    )
    assert.deepEqual(
      reports,
      [true],
    )
  },
)

test(
  'a layout scroll near the bottom without owner input does not resume following',
  () => {
    const { follow } = tracked()
    follow.input({ at: 0 })
    follow.stop()
    follow.scrolled({
      at: 10,
      top: 990,
      remaining: 0,
    })
    assert.equal(
      follow.following(),
      false,
    )
  },
)
