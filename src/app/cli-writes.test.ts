import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from './cli.ts'
import { readEvents } from './event-log.ts'

test(
  'a repeated hydra create is a no-op, other settings conflict, and task create needs an attached project',
  () => {
    process.env.PNYX_HOME = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-cli-writes-',
    )))
    commands.hydra([
      'create',
      'default',
    ])
    const logged = readEvents({ hydraId: 'default' }).length

    assert.deepEqual(
      commands.hydra([
        'create',
        'default',
      ]),
      { event: 'none: unchanged' },
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      logged,
      'the repeated create appends nothing',
    )
    assert.throws(
      () => commands.hydra([
        'create',
        'default',
        '--command',
        'echo',
      ]),
      {
        code: 'CONFLICT',
        message: /Hydra already exists with other settings: default/,
      },
    )
    assert.throws(
      () => commands.task([
        'create',
        '--title',
        'Fix the cart total',
        '--project',
        'shop',
      ]),
      {
        code: 'NOT_FOUND',
        message: /project not attached: shop/,
      },
    )
  },
)
