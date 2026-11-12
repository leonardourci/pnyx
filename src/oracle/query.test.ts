import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matches, queryTerms, tokens } from './query.ts'

test(
  'inflection keeps short words distinct while matching longer suffixes',
  () => {
    assert.equal(
      matches({
        word: 'ring',
        term: {
          alts: ['red'],
          prefix: false,
          typo: false,
        },
        fuzzy: false,
      }),
      false,
    )
    assert.equal(
      matches({
        word: 'bed',
        term: {
          alts: ['bing'],
          prefix: false,
          typo: false,
        },
        fuzzy: false,
      }),
      false,
    )
    assert.equal(
      matches({
        word: 'deploying',
        term: {
          alts: ['deployed'],
          prefix: false,
          typo: false,
        },
        fuzzy: false,
      }),
      true,
    )
  },
)

test(
  'search words split at punctuation the same way in every search box',
  () => {
    assert.deepEqual(
      tokens({ text: 'Deploy/rollback: CI-CD' }),
      [
        'deploy',
        'rollback',
        'ci',
        'cd',
      ],
    )
  },
)

test(
  'server search keeps a word with punctuation, such as a path, as one phrase without synonyms',
  () => {
    assert.deepEqual(
      queryTerms({ text: 'web/src/app fix-ci*' }),
      [
        {
          alts: ['web src app'],
          prefix: false,
          typo: false,
        },
        {
          alts: ['fix ci'],
          prefix: true,
          typo: false,
        },
      ],
    )
  },
)
