import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import { hydraDigest } from './digest.ts'

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
