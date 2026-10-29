import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchingSuggestions, suggestionMatch } from './suggestion-matches.ts'

const name = ({ item }: { item: string }) => item

test(
  'composer suggestions ignore case, spaces and punctuation anywhere in names',
  () => {
    const items = [
      'Update the chat comment feature prompt',
      '$review-the-chat',
      '/open_chat',
      'Unrelated',
    ]
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: 'ThE.cHaT',
        name,
      }),
      [
        'Update the chat comment feature prompt',
        '$review-the-chat',
      ],
    )
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: '/CHAT',
        name,
      }),
      [
        'Update the chat comment feature prompt',
        '$review-the-chat',
        '/open_chat',
      ],
    )
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: 'zzzq',
        name,
      }),
      [],
    )
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: '',
        name,
      }),
      items,
    )
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: ' /.- ',
        name,
      }),
      items,
    )
  },
)

test(
  'prefixes precede word starts and other substrings, preserving order within each group',
  () => {
    const items = [
      'Rechat second',
      'Update chat first',
      '$chat-second',
      'Rechat first',
      '/chat-first',
      'Review chat second',
    ]
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: 'chat',
        name,
      }),
      [
        '$chat-second',
        '/chat-first',
        'Update chat first',
        'Review chat second',
        'Rechat second',
        'Rechat first',
      ],
    )
  },
)

test(
  'word starts win when an earlier occurrence is inside a word, and extra context ranks last',
  () => {
    const items = [
      {
        title: 'Other',
        prompt: 'chat',
      },
      {
        title: 'Rechat',
        prompt: '',
      },
      {
        title: 'Rechat then chat',
        prompt: '',
      },
      {
        title: 'Chat',
        prompt: '',
      },
    ]
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: 'chat',
        name: ({ item }) => item.title,
        fallback: ({ item }) => item.prompt,
      }).map(item => item.title),
      [
        'Chat',
        'Rechat then chat',
        'Rechat',
        'Other',
      ],
    )
  },
)

test(
  'fuzzy suggestions allow gaps and expose the original matched letters',
  () => {
    const name = 'Update the chat comment feature prompt'
    const match = suggestionMatch({
      name,
      query: '@CHAT.fea',
    })
    assert.equal(
      match?.ranges.map(({
        from,
        to,
      }) => name.slice(
        from,
        to,
      )).join(''),
      'chatfea',
    )
    assert.deepEqual(
      matchingSuggestions({
        items: [name],
        query: 'chatfea',
        name: ({ item }) => item,
      }),
      [name],
    )
    assert.equal(
      suggestionMatch({
        name: 'chat',
        query: 'tc',
      }),
      undefined,
    )
    assert.equal(
      suggestionMatch({
        name: 'a',
        query: 'aa',
      }),
      undefined,
    )
  },
)

test(
  'fuzzy ranking prefers a prefix, fewer gaps, then more matched word starts, and stable ties',
  () => {
    const items = [
      'a x b',
      'x ab',
      'abacus',
      'x a b',
      'y a b',
      'x axb',
    ]
    assert.deepEqual(
      matchingSuggestions({
        items,
        query: 'ab',
        name: ({ item }) => item,
      }),
      [
        'abacus',
        'x a b',
        'y a b',
        'x ab',
        'a x b',
        'x axb',
      ],
    )
  },
)

test(
  'fuzzy matching chooses the tightest occurrence and keeps Unicode highlight offsets',
  () => {
    const name = 'a long a b'
    const match = suggestionMatch({
      name,
      query: 'ab',
    })
    assert.deepEqual(
      match?.ranges,
      [
        {
          from: 7,
          to: 8,
        },
        {
          from: 9,
          to: 10,
        },
      ],
    )
    const unicode = '🙂 À—B'
    assert.deepEqual(
      suggestionMatch({
        name: unicode,
        query: 'àb',
      })?.ranges,
      [
        {
          from: 3,
          to: 4,
        },
        {
          from: 5,
          to: 6,
        },
      ],
    )
  },
)

test(
  'case-insensitive matching treats Greek final sigma like ordinary sigma',
  () => {
    assert.deepEqual(
      suggestionMatch({
        name: 'ΟΣ',
        query: 'ος',
      })?.ranges,
      [
        {
          from: 0,
          to: 1,
        },
        {
          from: 1,
          to: 2,
        },
      ],
    )
    assert.equal(
      suggestionMatch({
        name: 'ος',
        query: 'ΟΣ',
      })?.prefix,
      true,
    )
  },
)
