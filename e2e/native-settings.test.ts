import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFixture } from '#test-harness/child-fixture.ts'

test(
  'failed live settings wait for background, queued and unknown native work before retirement',
  async t => {
    assert.match(
      await runFixture({
        t,
        name: 'native-settings',
      }),
      /Rejected live settings retained background, queued and unknown native work until settled/,
    )
  },
)
