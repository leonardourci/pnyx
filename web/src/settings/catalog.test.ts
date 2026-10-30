import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchSettings, type CatalogEntry } from './catalog.ts'

const ENTRIES: CatalogEntry[] = [
  {
    id: 'size',
    section: 'appearance',
    label: 'Text size',
    description: 'Labels and menus.',
    related: ['bigger'],
  },
  {
    id: 'width',
    section: 'layout',
    label: 'Chat width',
    description: 'How wide the chat starts.',
    values: ['Narrow'],
    related: [
      'size',
      'bigger',
    ],
  },
]

const found = ({
  query,
  entries,
}: {
  query: string
  entries?: CatalogEntry[]
}) => searchSettings({
  query,
  entries,
})
  .map(match => match.entry.id)

test(
  'the Oracle keyboard query finds the shortcut setting',
  () => {
    assert.ok(found({ query: 'keyboard' }).includes('keyboard'))
  },
)

test(
  'a search matches names, descriptions and values, every word must match, and direct words are highlighted',
  () => {
    assert.deepEqual(
      found({
        query: 'narrow',
        entries: ENTRIES,
      }),
      ['width'],
    )
    assert.deepEqual(
      found({
        query: 'chat menus',
        entries: ENTRIES,
      }),
      [],
    )
    assert.deepEqual(
      searchSettings({
        query: 'Chat starts',
        entries: ENTRIES,
      }).map(match => match.terms),
      [
        [
          'chat',
          'starts',
        ],
      ],
    )
    assert.deepEqual(
      found({
        query: '',
        entries: ENTRIES,
      }),
      [
        'size',
        'width',
      ],
    )
  },
)

test(
  'related words widen only a word that matches nothing directly, by prefix',
  () => {
    assert.deepEqual(
      found({
        query: 'big',
        entries: ENTRIES,
      }),
      [
        'size',
        'width',
      ],
    )
    assert.deepEqual(
      found({
        query: 'size',
        entries: ENTRIES,
      }),
      ['size'],
    )
    assert.deepEqual(
      searchSettings({
        query: 'bigger',
        entries: ENTRIES,
      })[0]?.terms,
      [],
    )
  },
)

test(
  'the real catalog finds Theme by a value and the text sizes by a related word',
  () => {
    assert.deepEqual(
      found({ query: 'dark' }),
      ['theme'],
    )
    assert.deepEqual(
      found({ query: 'bigger' }),
      [
        'fontSize',
        'chatFontSize',
        'codeFontSize',
      ],
    )
  },
)
