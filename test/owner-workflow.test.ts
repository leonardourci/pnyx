import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/app/cli.ts'
import { loadHydra } from '../src/app/store.ts'
import { writeProjectMemory, readProjectMemory } from '../src/projects/memory.ts'
import { projectIdentity } from '../src/projects/sources.ts'

function fixture() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-owner-workflow-',
  ))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home

  return {
    home,
    close: () => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    },
  }
}

test(
  'the CLI keeps asks separate through intake, quote validation, task messages and instruction changes',
  async () => {
    const f = fixture()

    try {
      await commands.hydra([
        'create',
        'default',
        '--actor',
        'cli',
      ])
      await commands.task([
        'create',
        '--key',
        'save',
        '--title',
        'Saving',
        '--ask',
        'Fix saving',
        '--brief',
        'Reproduce first',
        '--actor',
        'cli',
      ])
      await commands.hydra([
        'send',
        '--task',
        'save',
        '--text',
        'Preserve keyboard saving',
        '--actor',
        'cli',
      ])
      await commands.task([
        'brief',
        'save',
        '--brief',
        'Check both paths',
        '--actor',
        'hydra',
        '--reason',
        'Both paths are requested',
      ])
      const state = loadHydra({ hydraId: 'default' }).state
      const task = state.cards[state.keys.save!]!
      assert.deepEqual(
        task.ask?.map(entry => entry.text),
        [
          'Fix saving',
          'Preserve keyboard saving',
        ],
      )
      assert.equal(
        task.brief,
        'Check both paths',
      )
      assert.throws(
        () => commands.task([
          'intent',
          'save',
          '--text',
          'Add monitoring',
          '--reason',
          'A proposed scope change',
          '--actor',
          'hydra',
        ]),
        /Only the owner/,
      )
      assert.throws(
        () => commands.undo([
          task.ask![1]!.message!,
          '--actor',
          'cli',
        ]),
        /durable work history/,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'project learnings age separately and confirmation preserves newer document edits',
  () => {
    const f = fixture()

    try {
      const first = {
        actor: 'cli',
        at: '2026-09-01T00:00:00Z',
      }
      writeProjectMemory({
        path: f.home,
        hydraId: 'default',
        key: 'learnings',
        after: 'One\nTwo',
        meta: first,
      })
      writeProjectMemory({
        path: f.home,
        hydraId: 'default',
        key: 'learnings',
        after: 'One\nThree',
        meta: {
          ...first,
          at: '2026-10-22T00:00:00Z',
        },
      })
      writeProjectMemory({
        path: f.home,
        hydraId: 'default',
        key: 'learnings',
        after: 'One\nTwo',
        confirmed: 'One',
        meta: {
          ...first,
          at: '2026-10-23T00:00:00Z',
          reason: 'Reproduced in this session',
        },
      })
      const memory = readProjectMemory(projectIdentity({ path: f.home }))
      assert.equal(
        memory.documents.learnings,
        'One\nThree',
      )
      assert.equal(
        memory.learnings![0]!.at,
        '2026-10-23T00:00:00Z',
      )
      assert.equal(
        memory.learnings![1]!.at,
        '2026-10-22T00:00:00Z',
      )
      assert.equal(
        memory.events[0]!.after,
        'One\nTwo',
      )
    } finally {
      f.close()
    }
  },
)
