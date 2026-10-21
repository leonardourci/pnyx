import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHydra } from '../src/store/hydra-store.ts'
import { taskTimeline } from '../web/src/hydra/task-updates.ts'

test(
  'task updates retain every declaration, deduplicate history and include factual events newest first',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-updates-',
    ))
    process.env.PNYX_HOME = home

    try {
      commands.task([
        'create',
        '--key',
        'example',
        '--title',
        'Check the migration',
        '--column',
        'in_progress',
      ])

      for (const state of [
        'working',
        'needs_you',
        'paused',
        'blocked',
        'done',
      ]) {
        commands.task([
          'status',
          'example',
          state,
          '--note',
          `Status: ${state}`,
        ])
      }

      const state = loadHydra({ hydraId: 'default' }).state
      const card = state.cards[state.keys.example!]!
      const latest = card.statusLog!.at(-1)!
      const initial = card.statusLog![0]!
      const updates = taskTimeline({
        card,
        events: [
          {
            id: latest.id,
            seq: 6,
            at: latest.at,
            type: 'task.declared',
            summary: '',
            data: { ...latest },
          },
          {
            id: initial.id,
            seq: 1,
            at: initial.at,
            type: 'task.created',
            summary: 'Created task',
          },
          {
            id: 'chat',
            seq: 7,
            at: '2030-01-01T00:00:00Z',
            type: 'chat.message',
            summary: 'Transcript',
          },
        ],
      })

      assert.equal(
        updates.length,
        6,
      )
      assert.equal(
        updates[0]!.state,
        'done',
      )
      assert.equal(
        updates.at(-1)!.note,
        'Created task',
      )
      assert.equal(
        updates.filter(update => update.id === latest.id).length,
        1,
      )
      assert.ok(updates.every(update => update.at && update.note))
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }
    }
  },
)
