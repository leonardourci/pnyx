import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadCommentRecords, readCommentRecord, saveCommentRecords } from './comment-storage.ts'
import { createChatDrafts } from './chat-drafts.ts'
import type { ChatComment } from './chat.ts'

const key = 'fixture:comments'
const prefix = `${key}:%24hydra:`
const first: ChatComment = {
  id: 'first',
  messageId: 'reply',
  block: 0,
  offset: 0,
  quote: 'A passage',
  text: 'Saved first',
}
const second = {
  ...first,
  id: 'second',
  text: 'Saved second',
}

function commentStorage() {
  const records = new Map<string, string>()

  return {
    get length() {
      return records.size
    },
    // eslint-disable-next-line pnyx/object-params -- Storage contract.
    getItem(key: string) {
      return records.get(key) ?? null
    },
    // eslint-disable-next-line pnyx/object-params -- Storage contract.
    setItem(
      key: string,
      value: string,
    ) {
      records.set(
        key,
        value,
      )
    },
    // eslint-disable-next-line pnyx/object-params -- Storage contract.
    removeItem(key: string) {
      records.delete(key)
    },
    // eslint-disable-next-line pnyx/object-params -- Storage contract.
    key(index: number) {
      return [...records.keys()][index] ?? null
    },
  }
}

test(
  'legacy comments migrate once without replacing newer records or losing other cards',
  () => {
    const storage = commentStorage()
    storage.setItem(
      key,
      JSON.stringify({
        $hydra: [
          first,
          second,
        ],
        card: [first],
      }),
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        text: 'Newer record',
      }),
    )
    storage.setItem(
      `${prefix}second`,
      'invalid-json',
    )
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Newer record',
        },
        second,
      ],
    )
    assert.equal(
      storage.getItem(key),
      null,
    )
    assert.deepEqual(
      JSON.parse(storage.getItem(`${key}:card:first`)!),
      first,
    )
    storage.removeItem(`${prefix}second`)
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Newer record',
        },
      ],
    )
  },
)

test(
  'independent tab saves retain edits and a stale tab cannot restore an untouched deleted comment',
  () => {
    const storage = commentStorage()
    saveCommentRecords({
      storage,
      key,
      comments: [
        first,
        second,
      ],
      previous: [],
    })
    const a = createChatDrafts({
      comments: loadCommentRecords({
        storage,
        key,
      }),
      save: ({
        comments,
        previous,
      }) => saveCommentRecords({
        storage,
        key,
        comments,
        previous,
      }),
    })
    const b = createChatDrafts({
      comments: loadCommentRecords({
        storage,
        key,
      }),
      save: ({
        comments,
        previous,
      }) => saveCommentRecords({
        storage,
        key,
        comments,
        previous,
      }),
    })
    a.editComment({
      id: 'first',
      text: 'Tab A',
    })
    b.editComment({
      id: 'second',
      text: 'Tab B',
    })
    a.flush()
    b.flush()
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Tab A',
        },
        {
          ...second,
          text: 'Tab B',
        },
      ],
    )
    a.setComments({ items: [a.read().comments[0]!] })
    a.flush()
    b.editComment({
      id: 'first',
      text: 'Another edit',
    })
    b.flush()
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Another edit',
        },
      ],
    )
  },
)

test(
  'partial writes keep only rejected records dirty and malformed records are ignored',
  t => {
    const storage = commentStorage()
    saveCommentRecords({
      storage,
      key,
      comments: [
        first,
        second,
      ],
      previous: [],
    })
    const set = storage.setItem
    t.mock.method(
      storage,
      'setItem',
      // eslint-disable-next-line pnyx/object-params -- Storage contract.
      (
        name: string,
        value: string,
      ) => {
        if (name === `${prefix}second`) {
          throw new Error('Blocked storage')
        }

        set(
          name,
          value,
        )
      },
    )
    const changed = [
      {
        ...first,
        text: 'A',
      },
      {
        ...second,
        text: 'B',
      },
    ]
    const previous = saveCommentRecords({
      storage,
      key,
      comments: changed,
      previous: [
        first,
        second,
      ],
    })
    assert.deepEqual(
      previous,
      [
        {
          ...first,
          text: 'A',
        },
        second,
      ],
    )
    set(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        text: 'Remote A',
      }),
    )
    t.mock.restoreAll()
    saveCommentRecords({
      storage,
      key,
      comments: changed,
      previous,
    })
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Remote A',
        },
        {
          ...second,
          text: 'B',
        },
      ],
    )
    storage.setItem(
      `${prefix}first`,
      'invalid-json',
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        text: 42,
      }),
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        end: {
          position: 0,
          offset: 'x',
        },
      }),
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        end: { offset: 0 },
      }),
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        offset: -1,
      }),
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.setItem(
      `${prefix}first`,
      JSON.stringify({
        ...first,
        images: [1],
      }),
    )
    assert.equal(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      undefined,
    )
    storage.removeItem(`${prefix}first`)
    assert.deepEqual(
      readCommentRecord({
        storage,
        prefix,
        key: `${prefix}first`,
      }),
      {
        id: 'first',
        comment: null,
      },
    )
  },
)

test(
  'failed migration retains the legacy list and retries without losing mounted comments',
  t => {
    const storage = commentStorage()
    storage.setItem(
      key,
      JSON.stringify({
        $hydra: [
          first,
          second,
        ],
      }),
    )
    const set = storage.setItem
    t.mock.method(
      storage,
      'setItem',
      // eslint-disable-next-line pnyx/object-params -- Storage contract.
      (
        name: string,
        value: string,
      ) => {
        if (name === `${prefix}second`) {
          throw new Error('Quota exceeded')
        }

        set(
          name,
          value,
        )
      },
    )
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        first,
        second,
      ],
    )
    assert.ok(storage.getItem(key))
    assert.deepEqual(
      saveCommentRecords({
        storage,
        key,
        comments: [
          {
            ...first,
            text: 'Unsaved',
          },
        ],
        previous: [
          first,
          second,
        ],
      }),
      [
        first,
        second,
      ],
    )
    t.mock.restoreAll()
    saveCommentRecords({
      storage,
      key,
      comments: [
        {
          ...first,
          text: 'Saved after retry',
        },
      ],
      previous: [
        first,
        second,
      ],
    })
    assert.equal(
      storage.getItem(key),
      null,
    )
    assert.deepEqual(
      loadCommentRecords({
        storage,
        key,
      }),
      [
        {
          ...first,
          text: 'Saved after retry',
        },
      ],
    )
  },
)
