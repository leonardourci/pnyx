import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchingSuggestions } from '#hydra/suggestion-matches.ts'
import { draftView } from './draft.ts'
import { reference, taskMention } from '#hydra/mentions.ts'
import { slashPrefix } from './view.ts'

const suggestions = ({
  text,
  cursor = text.length,
}: {
  text: string
  cursor?: number
}) => {
  const query = slashPrefix({
    text,
    cursor,
  })

  return query === null ? [] : matchingSuggestions({
    items: [
      '$review-the-chat',
      '/thechat',
      '/other',
    ],
    query,
    name: ({ item }) => item,
  })
}

test(
  'slash suggestions normalize spaced and punctuated queries through the composer parser',
  () => {
    assert.deepEqual(
      suggestions({ text: 'Try /the chat' }),
      [
        '/thechat',
        '$review-the-chat',
      ],
    )
    assert.deepEqual(
      suggestions({ text: '/THE,CHAT' }),
      [
        '/thechat',
        '$review-the-chat',
      ],
    )
    assert.deepEqual(
      suggestions({ text: '/the/chat' }),
      [
        '/thechat',
        '$review-the-chat',
      ],
    )
    assert.deepEqual(
      suggestions({
        text: '/thechat later',
        cursor: 8,
      }),
      [
        '/thechat',
        '$review-the-chat',
      ],
    )
  },
)

test(
  'slash queries match spaced words in reverse order',
  () => {
    assert.deepEqual(
      suggestions({ text: '/chat review' }),
      ['$review-the-chat'],
    )
  },
)

test(
  'slash queries end at newlines, mention triggers and inserted chip boundaries',
  () => {
    assert.equal(
      slashPrefix({
        text: '/chat\nnext',
        cursor: 10,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: '/chat @task',
        cursor: 11,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: '/chat\u2060 next',
        cursor: 11,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: 'https://example.test',
        cursor: 20,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: 'Use /the chat',
        cursor: 13,
      }),
      '/the chat',
    )
  },
)

test(
  'slashes inside task and project chips cannot reopen a menu or replace the reference',
  () => {
    const task = draftView({
      text: taskMention({
        id: 't',
        title: 'Fix /chat',
      }) + ' ',
    })
    const project = draftView({
      text: reference({
        kind: 'project',
        value: '/synthetic/project',
        label: 'Project /chat',
      }) + ' ',
    })
    assert.equal(
      slashPrefix({
        text: task.display,
        cursor: task.display.length,
        chips: task.chips,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: project.display,
        cursor: project.display.length,
        chips: project.chips,
      }),
      null,
    )
    assert.equal(
      slashPrefix({
        text: task.display + '/chat',
        cursor: task.display.length + 5,
        chips: task.chips,
      }),
      '/chat',
    )
    assert.equal(
      slashPrefix({
        text: '/help /chat',
        cursor: 11,
      }),
      '/chat',
    )
  },
)
