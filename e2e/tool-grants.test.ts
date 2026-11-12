import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFixture } from '#test-harness/child-fixture.ts'

test(
  'tool grants resume the same Claude and Codex conversations only after the running turn finishes',
  async t => {
    assert.match(
      await runFixture({
        t,
        name: 'tool-grants',
      }),
      /Tool grants and revocations resume Claude and Codex at safe turn boundaries/,
    )
  },
)
