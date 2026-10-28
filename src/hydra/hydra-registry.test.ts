import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraName } from './cli.ts'

test(
  'a Hydra name keeps whole words near 40 characters, never splits a character and needs real text',
  () => {
    assert.equal(
      hydraName({ text: '[image: /tmp/a.png]' }),
      undefined,
    )
    assert.equal(
      hydraName({ text: 'Short title\nmore' }),
      'Short title',
    )
    assert.equal(
      hydraName({ text: 'I supercalifragilisticexpialidocious-and-more-words-here' }),
      'I supercalifragilisticexpialidocious-and…',
    )
    assert.equal(
      hydraName({ text: `${'a'.repeat(39)}😀 more words` }),
      `${'a'.repeat(39)}…`,
    )
    assert.equal(
      hydraName({ text: '!'.repeat(50) }),
      undefined,
    )
    assert.equal(
      hydraName({ text: '[image: /h/a.png]\nIn [image: /h/b.png], it is big' }),
      'In Image 2, it is big',
    )
  },
)
