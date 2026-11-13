import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyDecision } from '#app/decision.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from './push.ts'
import { taskHistory } from './cli.ts'

test(
  'a task history includes its subtasks after filtering history in Postgres',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-task-history-',
    ))
    withWriter({
      hydraId: 'lab',
      create: true,
      fn: ({ writer }) => {
        for (const id of [
          'parent',
          'child',
        ]) {
          const input: {
            title: string
            parent?: string
          } = { title: id }

          if (id === 'child') {
            input.parent = 'parent'
          }

          applyDecision({
            writer,
            decision: decidePush({
              state: writer.state,
              key: id,
              input,
              newCardId: id,
              meta: {
                actor: 'test',
                id: `${id}-created`,
                at: '2026-11-13T12:00:00.000Z',
              },
            }),
          })
        }
      },
    })
    const history = taskHistory({
      hydraId: 'lab',
      ref: 'parent',
      limit: 20,
      full: true,
    }) as { events: { card: string }[] }
    assert.deepEqual(
      history.events.map(event => event.card),
      [
        'child',
        'parent',
      ],
    )
  },
)
