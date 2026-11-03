import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pnyxAxi, serve } from '#test-harness/served.ts'

test(
  'the real CLI offers live state, nested discovery, actionable receipts and explicit errors',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-discovery-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = root
    await serve({ t })
    t.after(() => {
      process.env.PNYX_HOME = previous
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PNYX_HOME: root,
      PNYX_ACTOR: 'cli',
      PNYX_HYDRA: 'default',
    }
    delete env.PNYX_TASK
    const run = ({ args }: { args: string[] }) => pnyxAxi({
      args,
      env,
    })
    const empty = await run({ args: [] })
    assert.equal(
      empty.status,
      0,
    )
    assert.match(
      empty.stdout,
      /none: no cards yet/,
    )
    assert.match(
      empty.stdout,
      /--help/,
    )
    const created = await run({
      args: [
        'task',
        'create',
        '--title',
        'Synthetic CLI task',
      ],
    })
    assert.equal(
      created.status,
      0,
    )
    const id = /id: (task-[\w-]+)/.exec(created.stdout)![1]!
    const home = await run({ args: [] })
    assert.match(
      home.stdout,
      /Synthetic CLI task/,
    )
    assert.match(
      home.stdout,
      new RegExp(`task show ${id}`),
    )
    const nested = await run({
      args: [
        'task',
        'source',
        'read',
        '--help',
      ],
    })
    assert.equal(
      nested.status,
      0,
    )
    assert.match(
      nested.stdout,
      /task source read/,
    )
    assert.doesNotMatch(
      nested.stdout,
      /task source stop|task source list/,
    )
    const paused = await run({
      args: [
        'task',
        'status',
        id,
        'paused',
        '--note',
        'Ready result',
      ],
    })
    assert.equal(
      paused.status,
      0,
    )
    assert.match(
      paused.stdout,
      /state: recorded/,
    )
    assert.match(
      paused.stdout,
      /hydra send --task/,
    )
    assert.match(
      paused.stdout,
      /No Hydra wake/,
    )
    const invalid = await run({
      args: [
        'task',
        'show',
        id,
        '--invented',
      ],
    })
    assert.equal(
      invalid.status,
      2,
    )
    assert.match(
      invalid.stdout,
      /VALIDATION_ERROR/,
    )
    assert.match(
      invalid.stdout,
      /Valid flags/,
    )
    const other = await run({
      args: [
        'hydra',
        'create',
        'synthetic-other',
      ],
    })
    assert.equal(
      other.status,
      0,
    )
    const scoped = await pnyxAxi({
      args: [],
      env: {
        ...env,
        PNYX_HYDRA: 'synthetic-other',
      },
    })
    assert.equal(
      scoped.status,
      0,
    )
    assert.match(
      scoped.stdout,
      /hydraId: synthetic-other/,
    )
    assert.match(
      scoped.stdout,
      /task create .*--hydra synthetic-other/,
    )
  },
)
