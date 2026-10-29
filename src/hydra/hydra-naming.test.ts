import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { nameUnnamedHydras } from '#app/server-hydras.ts'
import { HYDRA_NAMES } from './hydra-names.ts'
import type { HydraConfig } from './model.ts'

const freshHome = () => {
  process.env.PNYX_HOME = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-hydra-naming-',
  )))

  return process.env.PNYX_HOME
}

const shown = ({ id }: { id: string }) => (commands.hydra([
  'show',
  '--hydra',
  id,
]) as { hydra: HydraConfig }).hydra

const greek = ({ name }: { name: string }) => (HYDRA_NAMES as readonly string[]).includes(name)

test(
  'hydra create gives a Greek name and its icon, a rename keeps the icon, and --icon takes only known icons',
  () => {
    freshHome()
    commands.hydra([
      'create',
      'work',
    ])
    const created = shown({ id: 'work' })

    assert.ok(
      greek({ name: created.name }),
      created.name,
    )
    assert.equal(
      created.icon,
      created.name.toLowerCase(),
    )

    commands.hydra([
      'set',
      '--hydra',
      'work',
      '--name',
      'Billing',
    ])
    assert.deepEqual(
      [
        shown({ id: 'work' }).name,
        shown({ id: 'work' }).icon,
      ],
      [
        'Billing',
        created.icon,
      ],
    )

    assert.throws(
      () => commands.hydra([
        'set',
        '--hydra',
        'work',
        '--icon',
        'unicorn',
      ]),
      { code: 'VALIDATION_ERROR' },
    )

    commands.hydra([
      'set',
      '--hydra',
      'work',
      '--icon',
      'hydra',
    ])
    assert.equal(
      shown({ id: 'work' }).icon,
      undefined,
      'the Hydra mark is the icon of a Hydra without its own',
    )
  },
)

test(
  'the server names, once, each Hydra still called by its id and leaves named and Firstmate Hydras alone',
  () => {
    const home = freshHome()
    const firstmate = join(
      home,
      'crew',
    )
    mkdirSync(firstmate)
    commands.hydra([
      'create',
      'default',
      '--name',
      'default',
    ])
    commands.hydra([
      'create',
      'kept',
      '--name',
      'Billing',
    ])
    commands.hydra([
      'create',
      '--firstmate',
      firstmate,
    ])

    nameUnnamedHydras()
    const named = shown({ id: 'default' })

    assert.ok(
      greek({ name: named.name }),
      named.name,
    )
    assert.equal(
      shown({ id: 'kept' }).name,
      'Billing',
    )
    assert.equal(
      shown({ id: 'crew' }).name,
      'crew',
    )

    nameUnnamedHydras()
    assert.equal(
      shown({ id: 'default' }).name,
      named.name,
      'a named Hydra is not renamed again',
    )
  },
)
