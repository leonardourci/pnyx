import assert from 'node:assert/strict'
import test from 'node:test'
import { commentReply, orderedComments, type ChatComment } from '../web/src/hydra/chat.ts'
import { commentPileLayout, commentPiles } from '../web/src/hydra/comment-piles.ts'

test(
  'comment numbers follow the passages even when comments are created backwards',
  () => {
    const late: ChatComment = {
      id: 'late',
      messageId: 'reply',
      block: 0,
      offset: 0,
      start: 20,
      quote: 'later',
      text: 'Later note',
      at: '2026-10-21T12:00:00Z',
    }
    const early = {
      ...late,
      id: 'early',
      start: 2,
      quote: 'earlier',
      text: 'Earlier note',
    }
    const next = {
      ...late,
      id: 'next',
      messageId: 'next',
      at: '2026-10-21T12:01:00Z',
    }
    const comments = [
      next,
      late,
      early,
    ]
    assert.deepEqual(
      orderedComments({ comments }).map(comment => comment.id),
      [
        'early',
        'late',
        'next',
      ],
    )
    const reply = commentReply({
      draft: '',
      comments,
    })
    assert.match(
      reply,
      /1\. > earlier/,
    )
    assert.match(
      reply,
      /2\. > later/,
    )
    assert.match(
      reply,
      /3\. > later/,
    )
  },
)

test(
  'overlapping markers stack on the same line and spread in numbered order',
  () => {
    const piles = commentPiles({
      anchors: [
        {
          key: 'late',
          number: 3,
          top: 20,
          left: 90,
        },
        {
          key: 'first',
          number: 1,
          top: 0,
          left: 100,
        },
        {
          key: 'nested',
          number: 2,
          top: 1,
          left: 102,
        },
      ],
    })
    assert.deepEqual(
      piles.map(pile => pile.badges.map(badge => badge.number)),
      [
        [
          1,
          2,
        ],
        [3],
      ],
    )
    const closed = commentPileLayout({
      count: 2,
      active: -1,
      spread: false,
    })
    const spread = commentPileLayout({
      count: 2,
      active: 0,
      spread: true,
    })
    assert.ok(closed.width < spread.width)
    assert.ok(closed.positions[1]!.zIndex > closed.positions[0]!.zIndex)
    assert.ok(spread.positions[0]!.left < spread.positions[1]!.left)
    assert.ok(spread.positions[0]!.zIndex > spread.positions[1]!.zIndex)

    for (const active of [
      0,
      1,
      2,
    ]) {
      const pile = commentPileLayout({
        count: 3,
        active,
        spread: false,
      })
      assert.equal(
        pile.positions[active]!.zIndex,
        Math.max(...pile.positions.map(position => position.zIndex)),
      )
    }
  },
)

test(
  'reply order is stable when legacy timestamps are incomplete',
  () => {
    const base = {
      block: 0,
      offset: 0,
      quote: 'part',
      text: 'note',
    }
    const comments: ChatComment[] = [
      {
        ...base,
        id: 'later',
        messageId: 'later',
        at: '2026-10-21T12:02:00Z',
      },
      {
        ...base,
        id: 'undated',
        messageId: 'undated',
      },
      {
        ...base,
        id: 'earlier',
        messageId: 'earlier',
        at: '2026-10-21T12:00:00Z',
      },
    ]
    assert.deepEqual(
      orderedComments({ comments }).map(comment => comment.id),
      [
        'later',
        'undated',
        'earlier',
      ],
    )
    const complete = comments.map(comment => comment.id === 'undated' ? {
      ...comment,
      at: '2026-10-21T12:01:00Z',
    } : comment)
    assert.deepEqual(
      orderedComments({ comments: complete }).map(comment => comment.id),
      [
        'earlier',
        'undated',
        'later',
      ],
    )
  },
)
