import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskCommand } from '#app/task-cli.ts'
import { loadHydra } from '#app/store.ts'

test(
  'rename rejects ignored fields and repeated scalar flags without changing the task',
  t => {
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-rename-',
    ))
    const home = process.env.PNYX_HOME
    t.after(() => {
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const created = taskCommand({
      args: [
        'create',
        '--title',
        'Original',
        '--brief',
        'Original brief',
        '--actor',
        'cli',
      ],
    })
    assert.ok(!(created instanceof Promise))
    const id = (created.card as { id: string }).id
    assert.throws(
      () => taskCommand({
        args: [
          'rename',
          id,
          '--title',
          'Changed',
          '--brief',
          'Ignored',
        ],
      }),
      /brief/,
    )
    assert.throws(
      () => taskCommand({
        args: [
          'rename',
          id,
          '--title',
          'One',
          '--title',
          'Two',
        ],
      }),
      /title/,
    )
    assert.throws(
      () => taskCommand({
        args: [
          '--hydra',
          'default',
          'rename',
          id,
          '--title',
          'Changed',
          '--brief',
          'Ignored',
        ],
      }),
      /brief/,
    )
    assert.throws(
      () => taskCommand({
        args: [
          '--hydra',
          'default',
          'create',
          '--title',
          'Ignored dependency',
          '--on',
          id,
        ],
      }),
      /on/,
    )
    assert.throws(
      () => taskCommand({
        args: [
          'rename',
          id,
          'ignored',
          '--title',
          'Changed',
        ],
      }),
      /unexpected argument/,
    )
    assert.throws(
      () => taskCommand({
        args: [
          'brief',
          id,
        ],
      }),
      /--brief: required field/,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[id]?.title,
      'Original',
    )
  },
)
