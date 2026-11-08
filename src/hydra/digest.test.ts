import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import { hydraDigest } from './digest.ts'
import { countTokens } from '#workers/token-count.ts'

test(
  'the Hydra digest keeps column guidance compact and points to placement rules on demand',
  () => {
    const state = emptyHydra()
    state.config = {
      id: 'lab',
      name: 'Lab',
      hydra: {
        id: 'hydra',
        kind: 'agent',
        name: 'Hydra',
      },
      columns: [
        ...structuredClone(DEFAULT_COLUMNS),
        {
          id: 'custom:research',
          title: 'Research',
          description: 'Investigations that need evidence before implementation.',
          rule: [
            [
              'kind:investigation',
              '!done',
            ],
          ],
        },
      ],
    }
    const digest = hydraDigest({
      hydraId: 'lab',
      state,
      owner: {},
    })
    const columns = digest.slice(
      digest.indexOf('Columns ('),
      digest.indexOf('Open tasks ('),
    )

    assert.match(
      columns,
      /- queued · Queued · 0 · Work waiting for a worker to start it\./,
    )
    assert.match(
      columns,
      /- custom:research · Research · 0 · Investigations that need evidence before implementation\./,
    )
    assert.match(
      columns,
      /pnyx-axi column list --hydra lab/,
    )
    assert.doesNotMatch(
      columns,
      /owner-question|worker:working|kind:investigation| AND | OR /,
    )
  },
)

test(
  'owner context is bounded and tells Hydra how to recover omitted memory',
  () => {
    const digest = hydraDigest({
      hydraId: 'lab',
      state: emptyHydra(),
      owner: {
        preferences: {
          text: 'Preserve the release policy.\n'.repeat(600),
          at: '2026-01-01T00:00:00Z',
        },
        learnings: {
          text: 'Check the saved receipt.\n'.repeat(600),
          at: '2026-01-01T00:00:00Z',
        },
      },
    })
    const longPolicy = hydraDigest({
      hydraId: 'lab',
      state: emptyHydra(),
      owner: {
        preferences: {
          text: 'Never act on a partial policy. ' + 'condition '.repeat(2_000),
          at: '2026-01-01T00:00:00Z',
        },
      },
    })
    assert.doesNotMatch(
      longPolicy,
      /Never act on a partial policy/,
    )
    const memory = digest.slice(
      digest.indexOf('Owner preferences'),
      digest.indexOf('Hydra memory ('),
    )

    assert.ok(countTokens({ text: memory }) <= 3_000)
    assert.match(
      memory,
      /Preserve the release policy/,
    )
    assert.match(
      memory,
      /owner memory list/,
    )
    assert.match(
      memory,
      /omitted/,
    )
  },
)
