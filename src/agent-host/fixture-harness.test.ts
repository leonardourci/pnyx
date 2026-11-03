import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { readOwnedTree } from '#agent-host/fixtures/harness.ts'

test(
  'waits for the fixture process tree to be fully written',
  async t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-tree-read-',
    ))
    t.after(() => rmSync(
      dir,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      dir,
      'owned-tree.json',
    )
    writeFileSync(
      path,
      '{',
    )
    let settled = false
    const reading = readOwnedTree({ path }).then(tree => {
      settled = true

      return tree
    })
    await setImmediate()
    assert.equal(
      settled,
      false,
    )
    const expected = {
      parent: {
        pid: 1,
        start: 'parent',
      },
      tool: {
        pid: 2,
        start: 'tool',
      },
    }
    writeFileSync(
      path,
      JSON.stringify(expected),
    )
    assert.deepEqual(
      await reading,
      expected,
    )
  },
)
