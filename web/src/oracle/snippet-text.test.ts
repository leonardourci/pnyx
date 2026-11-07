import assert from 'node:assert/strict'
import { test } from 'node:test'
import { snippetText } from './snippet-text.ts'

test(
  'server matches retain their boundaries through Markdown summary formatting',
  () => {
    const parts = snippetText({
      snippet: {
        kind: 'note',
        at: '2026-01-01T00:00:00Z',
        snippet: '',
        parts: [
          {
            text: '**',
            matched: false,
          },
          {
            text: 'Migration',
            matched: true,
          },
          {
            text: '** uses [the ',
            matched: false,
          },
          {
            text: 'rollback',
            matched: true,
          },
          {
            text: ' guide](https://example.com/rollback) and `checks`.',
            matched: false,
          },
        ],
      },
    })
    assert.equal(
      parts.map(part => part.text).join(''),
      'Migration uses the rollback guide and checks.',
    )
    assert.deepEqual(
      parts.filter(part => part.matched).map(part => part.text),
      [
        'Migration',
        'rollback',
      ],
    )
  },
)

test(
  'an unhighlighted snippet keeps the existing Markdown summary',
  () => {
    assert.deepEqual(
      snippetText({
        snippet: {
          kind: 'note',
          at: '2026-01-01T00:00:00Z',
          snippet: '**Migration** uses [the guide](https://example.com).',
        },
      }),
      [
        {
          text: 'Migration uses the guide.',
          matched: false,
        },
      ],
    )
  },
)

test(
  'a match in a Markdown link destination stays hidden with that destination',
  () => {
    const parts = snippetText({
      snippet: {
        kind: 'note',
        at: '2026-01-01T00:00:00Z',
        snippet: '',
        parts: [
          {
            text: '[Guide](https://example.com/',
            matched: false,
          },
          {
            text: 'rollback',
            matched: true,
          },
          {
            text: ') then check ',
            matched: false,
          },
          {
            text: 'Migration',
            matched: true,
          },
          {
            text: '.',
            matched: false,
          },
        ],
      },
    })
    assert.equal(
      parts.map(part => part.text).join(''),
      'Guide then check Migration.',
    )
    assert.deepEqual(
      parts.filter(part => part.matched).map(part => part.text),
      ['Migration'],
    )
  },
)
