import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkBudget, OWNER_MEMORY_BUDGET } from '../src/core/digest.ts'
import { checkProjectMemoryBudget, PROJECT_MEMORY_BUDGET } from '../src/projects/memory.ts'

test(
  'an overfull owner memory can shrink while still over budget, but cannot grow',
  () => {
    const memory = {
      preferences: {
        text: 'x'.repeat(OWNER_MEMORY_BUDGET + 2),
        at: '2026-10-01',
      },
    }
    assert.doesNotThrow(() => checkBudget({
      memory,
      key: 'preferences',
      after: 'x'.repeat(OWNER_MEMORY_BUDGET + 1),
      budget: OWNER_MEMORY_BUDGET,
      layer: 'Owner',
    }))
    assert.throws(
      () => checkBudget({
        memory,
        key: 'learnings',
        after: 'New learning.',
        budget: OWNER_MEMORY_BUDGET,
        layer: 'Owner',
      }),
      { code: 'MEMORY_FULL' },
    )
  },
)

test(
  'an overfull project memory can shrink while still over budget, but cannot grow',
  () => {
    const memory = {
      documents: { preferences: 'x'.repeat(PROJECT_MEMORY_BUDGET + 2) },
      revision: 1,
      archived: [],
      sources: {},
      events: [],
    }
    assert.equal(
      checkProjectMemoryBudget({
        memory,
        key: 'preferences',
        after: 'x'.repeat(PROJECT_MEMORY_BUDGET + 1),
      }),
      PROJECT_MEMORY_BUDGET + 1,
    )
    assert.throws(
      () => checkProjectMemoryBudget({
        memory,
        key: 'learnings',
        after: 'New learning.',
      }),
      { code: 'MEMORY_FULL' },
    )
  },
)
