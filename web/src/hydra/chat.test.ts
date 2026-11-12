import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitEntry } from '#hydra/transcripts-read.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { hydraConversation } from '#hydra/conversation.ts'
import { taskMention } from '#hydra/mentions.ts'
import { commentReply, commentUpdates, copiedText, keepStreamedKeys, orderedComments, type ChatComment } from './chat.ts'
import { hasPendingImage, pendingImage, settleImage } from './draft.ts'
import { imageLine } from '#hydra/images.ts'

test(
  'a streamed reply keeps one key past 1,000 chars and when the transcript replaces it',
  () => {
    const live = ({ text }: { text: string }): ThreadEntry => ({
      id: 'live:msg_1',
      kind: 'message',
      role: 'assistant',
      text,
      streaming: true,
    })
    const owner: ThreadEntry = {
      id: '4:m0',
      kind: 'message',
      role: 'user',
      text: 'Explain streaming.',
    }
    const short = joinMessageParts({ entries: splitEntry({ entry: live({ text: 'word '.repeat(150) }) }) })
    const long = joinMessageParts({ entries: splitEntry({ entry: live({ text: 'word '.repeat(300) }) }) })
    assert.equal(
      long[0]!.id,
      short[0]!.id,
    )

    const keys = new Map<string, string>()
    const streaming = keepStreamedKeys({
      entries: [
        owner,
        ...long,
      ],
      previous: [],
      keys,
    })
    const final: ThreadEntry = {
      id: '5:m0',
      kind: 'message',
      role: 'assistant',
      text: 'word '.repeat(320),
    }
    const settled = keepStreamedKeys({
      entries: [
        owner,
        final,
      ],
      previous: streaming,
      keys,
    })
    const repeated = keepStreamedKeys({
      entries: [
        owner,
        final,
      ],
      previous: settled,
      keys,
    })
    assert.equal(
      repeated[0],
      owner,
    )
    assert.equal(
      repeated[1],
      settled[1],
      'an unchanged settled reply keeps its object as well as its key',
    )
    const failed = {
      ...owner,
      id: 'retry',
      streaming: true,
      sending: true,
      unsent: 'Waiting',
    }
    const delivered = {
      ...owner,
      id: 'retry',
    }
    const cleared = keepStreamedKeys({
      entries: [delivered],
      previous: [failed],
      keys: new Map(),
    })
    assert.equal(
      cleared[0],
      delivered,
    )
    assert.equal(
      'streaming' in cleared[0]!,
      false,
    )
    assert.equal(
      'sending' in cleared[0]!,
      false,
    )
    assert.equal(
      'unsent' in cleared[0]!,
      false,
    )
    assert.equal(
      settled[1]!.renderKey,
      'live:msg_1',
    )
    assert.equal(
      settled[0]!.renderKey,
      undefined,
    )
    keys.set(
      'evicted',
      'live:evicted',
    )
    assert.equal(
      keepStreamedKeys({
        entries: settled,
        previous: settled,
        keys,
      })[1]!.renderKey,
      'live:msg_1',
      'the key holds on later pages',
    )
    assert.equal(
      keys.has('evicted'),
      false,
    )
    assert.equal(
      keys.get(settled[1]!.id),
      'live:msg_1',
    )

    assert.equal(
      keepStreamedKeys<ThreadEntry>({
        entries: [
          {
            id: '2:m0',
            kind: 'message',
            role: 'assistant',
            text: 'word word',
          },
        ],
        previous: [
          {
            id: '2:m0',
            kind: 'message',
            role: 'assistant',
            text: 'word word',
          },
          live({ text: 'word' }),
        ],
        keys: new Map(),
      })[0]!.renderKey,
      undefined,
      'an older message never takes the key',
    )
  },
)

const comments: ChatComment[] = [
  {
    id: 'c1',
    messageId: 'm1',
    at: '15:42',
    block: 0,
    offset: 0,
    quote: 'Ship it\n\nafter review',
    text: 'Which review?\n\nThe second one.',
  },
  {
    id: 'c2',
    messageId: 'm1',
    at: '15:42',
    block: 1,
    offset: 0,
    quote: 'today',
    paragraph: 'Merge it today.',
    text: 'Tomorrow instead.',
    images: ['[image: /tmp/calendar.png]'],
  },
]

const commentSection = `## Comments on your reply from 15:42

### Comment 1
> Ship it
>
> after review

Which review?

The second one.

### Comment 2
> today
>
> > Merge it today.

Tomorrow instead.
[image: /tmp/calendar.png]`

test(
  'comments reach the agent in one shape, with a message section only when the owner wrote one',
  () => {
    assert.equal(
      commentReply({
        draft: '',
        comments,
      }),
      commentSection,
    )
    assert.equal(
      commentReply({
        draft: 'Thanks',
        comments: [],
      }),
      'Thanks',
    )
    assert.equal(
      commentReply({
        draft: '',
        comments: [
          comments[0]!,
          {
            ...comments[1]!,
            messageId: 'm2',
            at: '15:50',
          },
        ],
      }),
      '## Comments on your reply from 15:42\n\n### Comment 1\n> Ship it\n>\n> after review\n\nWhich review?\n\nThe second one.'
        + '\n\n## Comments on your reply from 15:50\n\n### Comment 1\n> today\n>\n> > Merge it today.\n\nTomorrow instead.\n[image: /tmp/calendar.png]',
    )
    assert.equal(
      commentReply({
        draft: 'Thanks',
        comments,
      }),
      `${commentSection}\n\n## Message\nThanks`,
    )
    assert.equal(
      commentReply({
        draft: '',
        comments: [
          {
            ...comments[0]!,
            text: '> Not this\n---\n## Message\n  # Nor this',
          },
        ],
      }),
      '## Comments on your reply from 15:42\n\n### Comment 1\n> Ship it\n>\n> after review\n\n\\> Not this\n---\n\\## Message\n  \\# Nor this',
    )
  },
)

const note = ({
  id,
  text,
}: {
  id: string
  text: string
}): ChatComment => ({
  id,
  messageId: 'm1',
  block: 0,
  offset: 0,
  quote: 'passage',
  text,
  at: '2026-10-29T15:05:10.536Z',
})

test(
  'comments that start at the same place keep one numbering whatever order storage returns them in',
  () => {
    const passage = ({
      id,
      position,
    }: {
      id: string
      position: number
    }): ChatComment => ({
      ...note({
        id,
        text: id,
      }),
      start: 0,
      end: {
        offset: 0,
        position,
      },
    })
    const comments = [
      passage({
        id: 'longer',
        position: 20,
      }),
      passage({
        id: 'twin',
        position: 7,
      }),
      passage({
        id: 'short',
        position: 7,
      }),
    ]
    const order = [
      'short',
      'twin',
      'longer',
    ]
    assert.deepEqual(
      orderedComments({ comments }).map(comment => comment.id),
      order,
    )
    assert.deepEqual(
      orderedComments({ comments: comments.toReversed() }).map(comment => comment.id),
      order,
    )
  },
)

// The comments as their owner holds them; handlers are made once, like a render's, and used later.

const store = ({ items }: { items: ChatComment[] }) => {
  const held = { items }

  return {
    held,
    updates: commentUpdates({
      read: () => held.items,
      write: ({ items }) => {
        held.items = items
      },
    }),
  }
}

test(
  'an image pasted over a passage keeps the reply waiting until its upload settles into the comment',
  () => {
    const path = pendingImage({ id: 'p' })
    const {
      held,
      updates,
    } = store({
      items: [
        note({
          id: 'a',
          text: '',
        }),
      ],
    })
    updates.edit({
      id: 'a',
      update: ({ text }) => [
        text,
        imageLine({ path }),
      ].filter(Boolean).join(' '),
    })
    const reply = () => commentReply({
      draft: 'also this',
      comments: held.items,
    })
    assert.equal(
      hasPendingImage({ text: reply() }),
      true,
      'Send waits while the image uploads',
    )
    updates.edit({
      id: 'a',
      update: ({ text }) => settleImage({
        text,
        anchor: 0,
        focus: 0,
        path,
        line: '[image: /home/.pnyx/hydras/default/attachments/0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b.png]',
      })?.text ?? text,
    })
    assert.match(
      reply(),
      /\[image: \/home\/\.pnyx\/hydras\/default\/attachments\/0b6e1f3a/,
    )
    assert.equal(
      hasPendingImage({ text: reply() }),
      false,
    )
  },
)

test(
  'copying a reply that opens with its task chip keeps the task',
  () => {
    const timing = ({ text }: { text: string }) => hydraConversation({
      messages: [],
      transcript: [
        {
          id: 'owner',
          kind: 'message',
          role: 'user',
          text: 'owner',
          at: '2026-10-22T10:00:00.000Z',
        },
        {
          id: 'reply',
          kind: 'message',
          role: 'assistant',
          text,
          at: '2026-10-22T10:01:00.000Z',
          task: 't1',
        },
      ],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
      actions: [],
    }).timings.get('reply')
    const reply = timing({ text: 'The worker found the cause.' })!
    assert.equal(
      copiedText({
        text: reply.reply,
        task: reply.task,
        title: 'Fix the login',
      }),
      `${taskMention({
        id: 't1',
        title: 'Fix the login',
      })} The worker found the cause.`,
    )
    assert.equal(
      timing({
        text: `${taskMention({
          id: 't1',
          title: 'Fix the login',
        })} found the cause.`,
      })?.task,
      undefined,
    )
  },
)
