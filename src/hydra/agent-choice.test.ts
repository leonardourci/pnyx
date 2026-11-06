import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraState } from '#app/model.ts'
import type { HeadsDispatch } from '#workers/dispatch-config.ts'
import { hydraCandidate } from './agent-choice.ts'

const noRules: HeadsDispatch = {
  rules: {},
  default: [],
  workers: {},
  projects: {},
}

test(
  'Hydra keeps the harness it runs on when no choice or dispatch rule names one',
  () => {
    const running = { cards: { $hydra: { agent: { provider: 'codex' } } } } as unknown as HydraState

    assert.equal(
      hydraCandidate({
        state: running,
        dispatch: noRules,
      }).harness,
      'codex',
    )
    assert.equal(
      hydraCandidate({
        state: running,
        dispatch: {
          ...noRules,
          default: [{ harness: 'claude' }],
        },
      }).harness,
      'claude',
    )
    assert.equal(
      hydraCandidate({
        state: {},
        dispatch: noRules,
      }).harness,
      'claude',
    )
  },
)
