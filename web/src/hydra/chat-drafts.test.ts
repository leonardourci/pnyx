import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageLine } from '#hydra/images.ts'
import { taskMention } from '#hydra/mentions.ts'
import { createChatDrafts } from './chat-drafts.ts'
import { commentReply, type ChatComment } from './chat.ts'
import { hasPendingImage, pendingImage } from './draft.ts'

test(
  'typing stays live for sending while conversation updates and storage wait for a pause',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const saved: {
      text: string
      comments: ChatComment[]
    }[] = []
    const drafts = createChatDrafts({
      save: ({
        text,
        comments,
      }) => {
        saved.push({
          text,
          comments,
        })

        return comments
      },
    })
    const original = drafts.readSettled()
    let liveUpdates = 0
    let conversationUpdates = 0
    const unsubscribe = drafts.subscribe(() => {
      liveUpdates += 1
    })
    drafts.subscribeSettled(() => {
      conversationUpdates += 1
    })

    drafts.setDraft({ text: 'Before the pause' })
    t.mock.timers.tick(499)
    assert.equal(
      drafts.read().text,
      'Before the pause',
    )
    assert.equal(
      drafts.readSettled(),
      original,
    )
    assert.equal(
      saved.length,
      0,
    )
    assert.equal(
      conversationUpdates,
      0,
    )
    assert.equal(
      liveUpdates,
      1,
    )

    drafts.setDraft({ text: 'Latest text' })
    t.mock.timers.tick(499)
    assert.equal(
      saved.length,
      0,
    )
    t.mock.timers.tick(1)
    assert.deepEqual(
      saved,
      [
        {
          text: 'Latest text',
          comments: [],
        },
      ],
    )
    assert.equal(
      drafts.readSettled().text,
      'Latest text',
    )
    assert.equal(
      conversationUpdates,
      1,
    )

    drafts.setComments({
      items: [
        {
          id: 'quote',
          messageId: 'message',
          block: 0,
          offset: 0,
          quote: 'A passage',
          text: '',
        },
      ],
    })
    assert.equal(
      drafts.readSettled().comments.length,
      1,
    )
    const quoted = drafts.readSettled()
    drafts.editComment({
      id: 'quote',
      text: 'Unpublished comment',
    })
    assert.equal(
      drafts.read().comments[0]!.text,
      'Unpublished comment',
    )
    assert.equal(
      drafts.readSettled(),
      quoted,
    )
    assert.equal(
      conversationUpdates,
      2,
    )
    assert.equal(
      saved.length,
      1,
    )

    drafts.flush()
    assert.deepEqual(
      saved[1],
      {
        text: 'Latest text',
        comments: [
          {
            id: 'quote',
            messageId: 'message',
            block: 0,
            offset: 0,
            quote: 'A passage',
            text: 'Unpublished comment',
          },
        ],
      },
    )
    t.mock.timers.tick(500)
    assert.equal(
      saved.length,
      2,
    )
    unsubscribe()
    drafts.setComments({ items: [] })
    assert.equal(
      drafts.read().comments.length,
      0,
    )
    drafts.flush()
  },
)

test(
  'another tab updates untouched comments while local edits and removals await saving',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const first: ChatComment = {
      id: 'first',
      messageId: 'reply',
      block: 0,
      offset: 0,
      quote: 'First passage',
      text: 'Saved first',
    }
    const second: ChatComment = {
      id: 'second',
      messageId: 'reply',
      block: 1,
      offset: 10,
      quote: 'Second passage',
      text: 'Saved second',
    }
    const added: ChatComment = {
      id: 'added',
      messageId: 'reply',
      block: 2,
      offset: 20,
      quote: 'Third passage',
      text: 'Local addition',
    }
    let saved: ChatComment[] = []
    const drafts = createChatDrafts({
      comments: [
        first,
        second,
      ],
      save: ({ comments }) => {
        saved = comments

        return comments
      },
    })
    drafts.editComment({
      id: 'first',
      text: 'Unpaused local edit',
    })
    drafts.setComments({
      items: [
        ...drafts.read().comments,
        added,
      ],
    })
    drafts.syncComment({
      id: 'second',
      comment: {
        ...second,
        text: 'Other tab edit',
      },
    })
    assert.deepEqual(
      drafts.read().comments,
      [
        {
          ...first,
          text: 'Unpaused local edit',
        },
        {
          ...second,
          text: 'Other tab edit',
        },
        added,
      ],
    )
    drafts.setComments({
      items: [
        {
          ...first,
          text: 'Unpaused local edit',
        },
        added,
      ],
    })
    drafts.syncComment({
      id: 'second',
      comment: second,
    })
    assert.deepEqual(
      drafts.read().comments,
      [
        {
          ...first,
          text: 'Unpaused local edit',
        },
        added,
      ],
    )
    drafts.flush()
    assert.deepEqual(
      saved,
      [
        {
          ...first,
          text: 'Unpaused local edit',
        },
        added,
      ],
    )
    drafts.syncComment({
      id: 'first',
      comment: {
        ...first,
        text: 'Later remote edit',
      },
    })
    assert.deepEqual(
      drafts.read().comments,
      [
        {
          ...first,
          text: 'Later remote edit',
        },
        added,
      ],
    )
    drafts.flush()
  },
)

test(
  'failed comment saves preserve local edits and removals across another tab’s save',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const first: ChatComment = {
      id: 'first',
      messageId: 'reply',
      block: 0,
      offset: 0,
      quote: 'First passage',
      text: 'Saved first',
    }
    const second = {
      ...first,
      id: 'second',
      text: 'Saved second',
    }
    const added = {
      ...first,
      id: 'added',
      text: 'Remote addition',
    }
    let succeeds = false
    const baselines: ChatComment[][] = []
    const drafts = createChatDrafts({
      comments: [
        first,
        second,
      ],
      save: ({
        comments,
        previous,
      }) => {
        baselines.push(previous)

        return succeeds ? comments : false
      },
    })
    drafts.flush()
    assert.deepEqual(
      baselines,
      [
        [
          first,
          second,
        ],
      ],
    )
    drafts.setComments({
      items: [
        {
          ...first,
          text: 'Unsaved local edit',
        },
      ],
    })
    drafts.flush()
    assert.deepEqual(
      baselines,
      [
        [
          first,
          second,
        ],
        [
          first,
          second,
        ],
      ],
    )
    drafts.syncComment({
      id: 'first',
      comment: first,
    })
    drafts.syncComment({
      id: 'second',
      comment: second,
    })
    drafts.syncComment({
      id: 'added',
      comment: added,
    })
    assert.deepEqual(
      drafts.read().comments,
      [
        {
          ...first,
          text: 'Unsaved local edit',
        },
        added,
      ],
    )
    succeeds = true
    drafts.flush()
    drafts.syncComment({
      id: 'first',
      comment: {
        ...first,
        text: 'Later remote edit',
      },
    })
    assert.deepEqual(
      drafts.read().comments,
      [
        {
          ...first,
          text: 'Later remote edit',
        },
        added,
      ],
    )
    drafts.flush()
    assert.deepEqual(
      baselines.at(-1),
      [
        {
          ...first,
          text: 'Later remote edit',
        },
        added,
      ],
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
  'a note that clears its upload after its comment was removed does not bring the comment back',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const drafts = createChatDrafts({
      comments: [
        note({
          id: 'a',
          text: `a ${imageLine({ path: pendingImage({ id: 'a' }) })}`,
        }),
        note({
          id: 'b',
          text: 'b',
        }),
      ],
      save: ({ comments }) => comments,
    })
    drafts.setComments({ items: drafts.read().comments.filter(comment => comment.id !== 'a') })
    drafts.editComment({
      id: 'a',
      text: 'a',
    })
    assert.deepEqual(
      drafts.read().comments.map(comment => comment.id),
      ['b'],
    )
  },
)

test(
  'two notes clearing their uploads one after the other both land, so Send is not left waiting',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const drafts = createChatDrafts({
      comments: [
        note({
          id: 'a',
          text: `a ${imageLine({ path: pendingImage({ id: 'a' }) })}`,
        }),
        note({
          id: 'b',
          text: `b ${imageLine({ path: pendingImage({ id: 'b' }) })}`,
        }),
      ],
      save: ({ comments }) => comments,
    })
    drafts.editComment({
      id: 'a',
      text: 'a',
    })
    drafts.editComment({
      id: 'b',
      text: 'b',
    })
    assert.equal(
      hasPendingImage({
        text: commentReply({
          draft: '',
          comments: drafts.read().comments,
        }),
      }),
      false,
    )
  },
)

test(
  'answering a task in chat shows its question at once, while the words after the mention wait for the pause',
  t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const drafts = createChatDrafts({ save: ({ comments }) => comments })
    const answer = `For ${taskMention({
      id: 't1',
      title: 'Fix the login',
    })}: `
    drafts.setDraft({ text: answer })
    assert.equal(
      drafts.readSettled().text,
      answer,
    )
    drafts.setDraft({ text: `${answer}yes` })
    assert.equal(
      drafts.readSettled().text,
      answer,
    )
    drafts.setDraft({ text: 'yes' })
    assert.equal(
      drafts.readSettled().text,
      'yes',
    )
  },
)
