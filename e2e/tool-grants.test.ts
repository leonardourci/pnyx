import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFixture } from '#test-harness/child-fixture.ts'

test(
  'tool grants resume the same Claude and Codex conversations only after the running turn finishes',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'tool-grants',
    })
    assert.match(
      stdout,
      /Tool grants and revocations resume Claude and Codex at safe turn boundaries/,
    )
    assert.match(
      stdout,
      /Hydra applies grants to its own card in the same conversation, including after restart/,
    )
  },
)
