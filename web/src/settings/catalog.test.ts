import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS_CATALOG, SETTINGS_SECTIONS, searchSettings } from './catalog.ts'

const found = ({ query }: { query: string }) => searchSettings({ query })
  .map(match => match.entry.id)

test(
  'a search matches names, descriptions and values, and every word must match',
  () => {
    assert.deepEqual(
      found({ query: 'dark' }),
      ['theme'],
    )
    assert.deepEqual(
      found({ query: 'chat width' }),
      [
        'defaultHydraWidth',
        'resetWidths',
      ],
    )
    assert.deepEqual(
      searchSettings({ query: 'Chat text' }).map(match => match.terms),
      [
        [
          'chat',
          'text',
        ],
      ],
    )
    assert.equal(
      found({ query: '' }).length,
      SETTINGS_CATALOG.length,
    )
  },
)

test(
  'related words widen only a word that matches nothing directly',
  () => {
    assert.deepEqual(
      found({ query: 'bigger' }),
      [
        'fontSize',
        'chatFontSize',
        'codeFontSize',
      ],
    )
    assert.deepEqual(
      found({ query: 'bigger code' }),
      ['codeFontSize'],
    )
    // "size" names the text sizes directly, so the width settings that list it as related stay out.
    assert.deepEqual(
      found({ query: 'size' }),
      [
        'fontSize',
        'chatFontSize',
        'codeFontSize',
      ],
    )
    assert.deepEqual(
      searchSettings({ query: 'bigger' })[0]?.terms,
      [],
    )
    assert.deepEqual(
      found({ query: 'nothing-like-this' }),
      [],
    )
  },
)

test(
  'every catalog entry belongs to a section and has a unique id',
  () => {
    const sections = new Set<string>(SETTINGS_SECTIONS.map(section => section.id))
    assert.ok(SETTINGS_CATALOG.every(entry => sections.has(entry.section)))
    assert.equal(
      new Set(SETTINGS_CATALOG.map(entry => entry.id)).size,
      SETTINGS_CATALOG.length,
    )
  },
)
