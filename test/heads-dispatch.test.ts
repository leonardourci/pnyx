import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraDefault } from '../web/src/hydra/heads-dispatch.ts'

test(
  'a default for another agent clears the settings that belonged to the old one',
  () => {
    const rule = {
      harness: 'claude' as const,
      model: 'claude-sonnet-5-5',
      effort: 'max',
      mode: 'acceptEdits',
    }
    assert.deepEqual(
      hydraDefault({
        rule,
        harness: 'codex',
        field: 'model',
        value: 'gpt-6.1-sol',
      }),
      {
        harness: 'codex',
        model: 'gpt-6.1-sol',
        effort: undefined,
        mode: undefined,
      },
    )
    assert.deepEqual(
      hydraDefault({
        rule,
        harness: 'claude',
        field: 'effort',
        value: 'high',
      }),
      {
        harness: 'claude',
        effort: 'high',
      },
    )
  },
)
