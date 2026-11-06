import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { updateIndex } from './index.ts'
import { search } from './search.ts'
import { readSearchFilters } from './filters.ts'
import { tokens } from './query.ts'

test(
  'column project and time filters select matching cards before the hit limit',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-oracle-filters-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      ; rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const state = withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const columns = hydraConfig({ state: writer.state }).columns
        const queued = columns.find(column => column.role === 'queued')!.id
        const other = columns.find(column => column.id !== queued)!.id

        for (let index = 0; index <= 120; index++) {
          const target = index === 120
          writer.append({
            event: {
              v: 1,
              seq: writer.state.seq + 1,
              id: `create-${index}`,
              at: target ? '2026-11-06T00:00:00Z' : '2020-01-01T00:00:00Z',
              actor: 'web',
              cardId: `task-${index}`,
              type: 'task.created',
              data: {
                key: `key-${index}`,
                title: 'Migration',
                brief: 'Migration notes',
                column: target ? queued : other,
                project: target ? '/wanted' : '/other',
              },
            },
          })
        }

        return writer.state
      },
    })
    updateIndex({ hydraId: 'default' })
    const queued = hydraConfig({ state }).columns.find(column => column.role === 'queued')!.id

    for (const filters of [
      { columns: [queued] },
      { projects: ['/wanted'] },
      { since: '2026-01-01T00:00:00Z' },
    ]) {
      const result = search({
        hydraId: 'default',
        state,
        query: {
          text: 'migration',
          limit: 1,
          ...filters,
        },
      })
      assert.deepEqual(
        result.hits.map(hit => hit.card),
        ['task-120'],
      )
      assert.equal(
        result.total,
        1,
      )
    }

    const fuzzy = search({
      hydraId: 'default',
      state,
      query: {
        text: 'migraton',
        limit: 1,
        columns: [queued],
        highlight: true,
      },
    })
    assert.equal(
      fuzzy.match,
      'fuzzy',
    )
    assert.ok(fuzzy.hits[0]!.snippets.some(snippet => snippet.parts?.some(part => part.matched && /migration/i.test(part.text))))
    assert.deepEqual(
      tokens({ text: 'Deploy/rollback: CI-CD' }),
      [
        'deploy',
        'rollback',
        'ci',
        'cd',
      ],
    )
  },
)

test(
  'Oracle filter payloads reject malformed and unknown values',
  () => {
    for (const value of [
      'null',
      '[]',
      '{',
      '{"columns":[1]}',
      '{"since":"no"}',
      '{"limit":1}',
    ]) {
      assert.throws(() => readSearchFilters({ value }))
    }
  },
)
