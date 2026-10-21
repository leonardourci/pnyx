import assert from 'node:assert/strict'
import test from 'node:test'
import { commentReply, orderedComments, quoteSnippet, type ChatComment } from '../web/src/hydra/chat.ts'
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
    assert.equal(
      closed.width,
      23,
    )
    assert.deepEqual(
      closed.positions,
      [
        {
          left: 3,
          zIndex: 1,
        },
        {
          left: 0,
          zIndex: 2,
        },
      ],
    )
    const spread = commentPileLayout({
      count: 2,
      active: 0,
      spread: true,
    })
    assert.equal(
      spread.width,
      44,
    )
    assert.deepEqual(
      spread.positions.map(position => position.left),
      [
        0,
        24,
      ],
    )
    assert.ok(spread.positions[0]!.zIndex > spread.positions[1]!.zIndex)
  },
)

test(
  'a repeated quote marks the occurrence selected for its comment',
  () => {
    assert.deepEqual(
      quoteSnippet({
        quote: 'word',
        context: 'word then word',
        start: 10,
      }),
      {
        before: 'word then ',
        match: 'word',
        after: '',
      },
    )
  },
)
