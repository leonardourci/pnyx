import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test(
  'the real CLI offers live state, nested discovery, actionable receipts and explicit errors',
  t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-discovery-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PNYX_HOME: root,
      PNYX_ACTOR: 'cli',
      PNYX_HYDRA: 'default',
    }
    delete env.PNYX_TASK
    const run = ({ args }: { args: string[] }) => spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
      },
    )
    const empty = run({ args: [] })
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
    const created = run({
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
    const home = run({ args: [] })
    assert.match(
      home.stdout,
      /Synthetic CLI task/,
    )
    assert.match(
      home.stdout,
      new RegExp(`task show ${id}`),
    )
    const nested = run({
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
    const paused = run({
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
    const invalid = run({
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
    const other = run({
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
    const scoped = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
      ],
      {
        env: {
          ...env,
          PNYX_HYDRA: 'synthetic-other',
        },
        encoding: 'utf8',
      },
    )
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
