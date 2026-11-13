import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookupMessages } from '#hydra/message-lookup.ts'
import { messageLookupCommand } from '#hydra/message-reference.ts'
import { lookupEntries, lookupEvents } from '#hydra/fixtures/message-lookup.ts'
import { commentReply, type ChatComment } from './chat.ts'

const comment: ChatComment = {
  id: 'a',
  messageId: '4:m0',
  reference: 'original:4:m0',
  at: lookupEntries[4].at,
  block: 0,
  offset: 0,
  quote: 'Recorded reply 5.',
  text: 'Expand this.',
}

test(
  'a comment carries the exact reference and a runnable scoped command for its surroundings',
  () => {
    const reference = lookupEntries[4].reference!
    const text = commentReply({
      draft: '',
      hydraId: 'fixture',
      comments: [
        {
          ...comment,
          reference,
        },
      ],
    })
    const command = messageLookupCommand({
      reference,
      hydraId: 'fixture',
    })!
    assert.ok(text.includes(`Message reference: ${reference}`))
    assert.ok(text.includes(command))
    const id = /--id '([^']+)'/.exec(command)![1]
    const before = Number(/--before (\d+)/.exec(command)![1])
    const after = Number(/--after (\d+)/.exec(command)![1])
    const page = lookupMessages({
      hydraId: 'fixture',
      events: lookupEvents,
      entries: lookupEntries,
      snapshot: 9,
      selection: {
        id,
        before,
        after,
      },
    })
    assert.deepEqual(
      page.messages.map(message => message.seq),
      [
        2,
        3,
        4,
        5,
        6,
        7,
        8,
      ],
    )
    const taskText = commentReply({
      draft: '',
      hydraId: 'fixture',
      card: 'task-fixture',
      comments: [comment],
    })
    assert.ok(taskText.includes("pnyx-axi task messages 'task-fixture' --id 'original:4:m0' --before 3 --after 3 --hydra 'fixture'"))
  },
)

test(
  'same-time replies retain separate references and old drafts can fall back to the timestamp',
  () => {
    const text = commentReply({
      draft: '',
      comments: [
        comment,
        {
          ...comment,
          id: 'b',
          messageId: 'another',
          reference: 'session:another',
        },
      ],
    })
    assert.equal(
      text.match(/## Comments on your reply/g)?.length,
      2,
    )
    assert.ok(text.includes('original:4:m0'))
    assert.ok(text.includes('session:another'))
    const legacy = commentReply({
      draft: '',
      comments: [
        {
          ...comment,
          reference: undefined,
        },
      ],
    })
    assert.ok(legacy.includes(`--at '${comment.at}'`))
    assert.ok(messageLookupCommand({
      reference: "session:it's",
      hydraId: 'fixture',
    })?.includes("'session:it'\\''s'"))
  },
)
