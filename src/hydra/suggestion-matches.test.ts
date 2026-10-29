import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchingSuggestions } from './suggestion-matches.ts'

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
        query: 'tct',
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
