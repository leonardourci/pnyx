import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queryTerms, termExpr, tokens } from './query.ts'

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
    const expression = ({ text }: { text: string }) => queryTerms({ text })
      .map(term => termExpr({ term }))
      .join(' AND ')
    assert.deepEqual(
      [
        'web/src/app',
        'deploy/rollback',
        'don\'t merge',
        'fix-ci*',
      ].map(text => expression({ text })),
      [
        '"web src app"',
        '"deploy rollback"',
        '"don t" AND "merge"',
        '"fix ci"*',
      ],
    )
  },
)
