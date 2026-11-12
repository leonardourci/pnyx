import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFixture } from '#test-harness/child-fixture.ts'

test(
  'application idle cleanup waits for native queued, background and unknown work',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'native-idle',
    })
    assert.match(
      stdout,
      /Native cleanup waited for queued, background and unknown work/,
    )
  },
)

test(
  'copy release rechecks work committed while its worker closes',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'copy-release',
    })
    assert.match(
      stdout,
      /Copy release rechecked final background work before removal/,
    )
  },
)
