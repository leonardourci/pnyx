import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { search } from './search.ts'
import { readSearchFilters, type SearchFilters } from './filters.ts'

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
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'create-other',
            at: '2020-01-01T00:00:00Z',
            actor: 'web',
            cardId: 'task-other',
            type: 'task.created',
            data: {
              key: 'other',
              title: 'Migration',
              brief: 'Migration notes',
              column: columns.find(column => column.role !== 'queued')!.id,
              project: '/other',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'create-target',
            at: '2026-11-06T00:00:00Z',
            actor: 'web',
            cardId: 'task-target',
            type: 'task.created',
            data: {
              key: 'target',
              title: 'Migration',
              brief: 'Migration notes',
              column: columns.find(column => column.role === 'queued')!.id,
              project: '/wanted',
            },
          },
        })

        return writer.state
      },
    })

    const first = ({ filters }: { filters: SearchFilters }) => {
      const result = search({
        hydraId: 'default',
        state,
        query: {
          text: 'migration',
          limit: 1,
          ...filters,
        },
      })

      return {
        cards: result.hits.map(hit => hit.card),
        total: result.total,
      }
    }

    assert.deepEqual(
      first({ filters: {} }),
      {
        cards: ['task-other'],
        total: 2,
      },
    )
    assert.deepEqual(
      first({ filters: { columns: ['queued'] } }),
      {
        cards: ['task-target'],
        total: 1,
      },
    )
    assert.deepEqual(
      first({ filters: { projects: ['/wanted'] } }),
      {
        cards: ['task-target'],
        total: 1,
      },
    )
    assert.deepEqual(
      first({ filters: { since: '2026-01-01T00:00:00.000Z' } }),
      {
        cards: ['task-target'],
        total: 1,
      },
    )

    const fuzzy = search({
      hydraId: 'default',
      state,
      query: {
        text: 'migraton',
        limit: 1,
        columns: ['queued'],
        highlight: true,
      },
    })
    assert.equal(
      fuzzy.match,
      'fuzzy',
    )
    assert.deepEqual(
      fuzzy.hits[0]!.snippets.map(snippet => snippet.parts),
      [
        [
          {
            text: 'Migration',
            matched: true,
          },
          {
            text: ' ',
            matched: false,
          },
          {
            text: 'Migration',
            matched: true,
          },
          {
            text: ' notes',
            matched: false,
          },
        ],
      ],
    )
  },
)

test(
  'Oracle filter payloads keep known filters and refuse malformed or unknown ones',
  () => {
    assert.deepEqual(
      readSearchFilters({ value: '{"columns":["queued"],"projects":["/app"],"since":"2026-01-01"}' }),
      {
        columns: ['queued'],
        projects: ['/app'],
        since: '2026-01-01T00:00:00.000Z',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: 'null' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'Oracle filters must be an object',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: '[]' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'Oracle filters must be an object',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: '{' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'invalid Oracle filters',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: '{"columns":[1]}' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'invalid Oracle columns',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: '{"since":"no"}' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'invalid Oracle filter: since',
      },
    )
    assert.throws(
      () => readSearchFilters({ value: '{"limit":1}' }),
      {
        code: 'VALIDATION_ERROR',
        message: 'invalid Oracle filter: limit',
      },
    )
  },
)
