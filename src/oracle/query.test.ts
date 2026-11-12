import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matches, queryTerms, tokens } from './query.ts'

const SAME_WORD = [
  [
    'update',
    'updates',
    'updated',
    'updating',
  ],
  [
    'release',
    'releases',
    'released',
  ],
  [
    'file',
    'files',
  ],
  [
    'issue',
    'issues',
  ],
  [
    'change',
    'changed',
  ],
  [
    'status',
    'statuses',
  ],
  [
    'run',
    'running',
  ],
  [
    'deploying',
    'deployed',
  ],
]
const DIFFERENT_WORDS = [
  [
    'not',
    'notes',
  ],
  [
    'ring',
    'red',
  ],
  [
    'bed',
    'bing',
  ],
]

const exactly = ({
  word,
  alt,
}: {
  word: string
  alt: string
}) => matches({
  word,
  term: {
    alts: [alt],
    prefix: false,
    typo: false,
  },
  fuzzy: false,
})

test(
  'inflections of one word match each other and unrelated short words stay distinct',
  () => {
    for (const forms of SAME_WORD) {
      for (const word of forms) {
        for (const alt of forms) {
          assert.equal(
            exactly({
              word,
              alt,
            }),
            true,
            `${word} matches ${alt}`,
          )
        }
      }
    }

    for (const [
      word,
      alt,
    ] of DIFFERENT_WORDS) {
      assert.equal(
        exactly({
          word: word!,
          alt: alt!,
        }),
        false,
        `${word} does not match ${alt}`,
      )
    }
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
