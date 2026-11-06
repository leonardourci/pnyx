import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraState } from '#app/model.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
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

test(
  'Hydra’s chosen agent comes before its dispatch rule, and its rule before the default',
  () => {
    const chosen = replay({
      state: emptyHydra(),
      events: [
        {
          v: 1,
          seq: 1,
          id: 'config',
          at: '2026-10-16T12:00:00Z',
          actor: 'test',
          cardId: '$board',
          type: 'board.configured',
          data: {
            id: 'default',
            name: 'Default',
            hydra: {
              id: 'hydra',
              kind: 'agent',
              name: 'Hydra',
              agent: { harness: 'claude' },
            },
            columns: structuredClone(DEFAULT_COLUMNS),
          },
        },
      ],
    })
    const ruled: HeadsDispatch = {
      ...noRules,
      rules: {
        hydra: {
          when: 'Hydra',
          candidates: [{ harness: 'codex' }],
        },
      },
      default: [{ harness: 'claude' }],
    }

    assert.equal(
      hydraCandidate({
        state: chosen,
        dispatch: ruled,
      }).harness,
      'claude',
    )
    assert.equal(
      hydraCandidate({
        state: emptyHydra(),
        dispatch: ruled,
      }).harness,
      'codex',
    )
  },
)
