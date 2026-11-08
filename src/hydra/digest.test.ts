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

test(
  'a resumed digest sends changed tasks and removed tasks without repeating unchanged owner memory',
  () => {
    const previous = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'first',
        actor: 'web',
        at: '2026-01-01T00:00:00Z',
        cardId: 'task:first',
        type: 'task.created',
        data: {
          key: 'first',
          title: 'Existing task',
        },
      },
    })
    const current = reduce({
      state: previous,
      event: {
        v: 1,
        seq: 2,
        id: 'second',
        actor: 'web',
        at: '2026-01-01T00:01:00Z',
        cardId: 'task:second',
        type: 'task.created',
        data: {
          key: 'second',
          title: 'New task',
        },
      },
    })
    const scoped = hydraDigest({
      hydraId: 'lab',
      state: current,
      owner: {},
      onlyTasks: ['task:second'],
    })
    assert.match(
      scoped,
      /New task/,
    )
    assert.doesNotMatch(
      scoped,
      /Existing task|Hydra memory \(this Hydra only\)/,
    )
    const previousDigest = hydraDigest({
      hydraId: 'lab',
      state: previous,
      checkpointed: true,
      owner: {
        preferences: {
          text: 'Preserve all release approvals.',
          at: '2026-01-01T00:00:00Z',
        },
      },
    })
    const digest = hydraDigest({
      hydraId: 'lab',
      state: current,
      checkpointed: true,
      previousDigest,
      owner: {
        preferences: {
          text: 'Preserve all release approvals.',
          at: '2026-01-01T00:00:00Z',
        },
      },
    })
    assert.match(
      digest,
      /New task/,
    )
    assert.doesNotMatch(
      digest,
      /Existing task|Preserve all release approvals/,
    )
    assert.match(
      digest,
      /hydra check --after 1 --hydra lab/,
    )
    const changedOwner = hydraDigest({
      hydraId: 'lab',
      state: current,
      previousDigest: digest,
      owner: {
        preferences: {
          text: 'Updated synthetic approval policy.',
          at: '2026-01-01T00:02:00Z',
        },
      },
    })
    assert.match(
      changedOwner,
      /Updated synthetic approval policy/,
    )
    assert.doesNotMatch(
      changedOwner,
      /Existing task|New task/,
    )
    const hidden = reduce({
      state: previous,
      event: {
        v: 1,
        seq: 2,
        id: 'hide',
        actor: 'web',
        at: '2026-01-01T00:01:00Z',
        cardId: 'task:first',
        type: 'task.visibility',
        data: {
          before: false,
          after: true,
        },
      },
    })
    assert.match(
      hydraDigest({
        hydraId: 'lab',
        state: hidden,
        previousDigest,
        owner: {},
      }),
      /task:first.*no longer listed/,
    )
  },
)

test(
  'moving an open task beyond the digest cap does not announce that it closed',
  () => {
    const state = emptyHydra()

    for (let index = 0; index < 41; index++) {
      const next = reduce({
        state,
        event: {
          v: 1,
          seq: index + 1,
          id: `created:${index}`,
          actor: 'web',
          at: '2026-01-01T00:00:00Z',
          cardId: `task:${index}`,
          type: 'task.created',
          data: {
            key: String(index),
            title: `Synthetic task ${index}`,
          },
        },
      })
      Object.assign(
        state,
        next,
      )
    }

    const previousDigest = hydraDigest({
      hydraId: 'lab',
      state,
      owner: {},
      checkpointed: true,
    })
    const current = structuredClone(state)
    current.cards['task:40']!.rank = -1
    const digest = hydraDigest({
      hydraId: 'lab',
      state: current,
      owner: {},
      previousDigest,
    })
    assert.match(
      digest,
      /Synthetic task 40/,
    )
    assert.doesNotMatch(
      digest,
      /no longer open/,
    )
    assert.match(
      digest,
      /task:39.*no longer listed/,
    )
  },
)
