import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { readEvents } from '#app/event-log.ts'
import { editHydra, listHydras, nameUnnamedHydras } from '#app/server-hydras.ts'
import { HYDRA_NAMES } from '#hydra/hydra-names.ts'
import type { HydraConfig } from '#hydra/model.ts'
import { runForRequest } from '#app/api-run.ts'

const shown = ({ id }: { id: string }) => (commands.hydra([
  'show',
  '--hydra',
  id,
]) as { hydra: HydraConfig }).hydra

const greek = ({ name }: { name: string }) => (HYDRA_NAMES as readonly string[]).includes(name)

test(
  'CLI discovers commands, validates task projects and preserves Hydra naming and ordering',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-discovery-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = root
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
    const run = ({
      args,
      hydra = 'default',
    }: {
      args: string[]
      hydra?: string
    }) => runForRequest({
      body: {
        argv: args,
        cwd: root,
        env: {
          PNYX_ACTOR: 'cli',
          PNYX_HYDRA: hydra,
        },
      },
    })
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
    await assert.rejects(
      async () => commands.task([
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
    const empty = await run({ args: [] })
    assert.equal(
      empty.exitCode,
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
      created.exitCode,
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
      nested.exitCode,
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
      paused.exitCode,
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
      invalid.exitCode,
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
      other.exitCode,
      0,
    )
    const scoped = await run({
      args: [],
      hydra: 'synthetic-other',
    })
    assert.equal(
      scoped.exitCode,
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

    {
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
    }

    {
      const firstmate = join(
        root,
        'crew',
      )
      mkdirSync(firstmate)
      commands.hydra([
        'set',
        '--hydra',
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
    }

    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2026-11-01T12:00:00Z'),
    })
    commands.hydra([
      'create',
      'zeta',
    ])
    t.mock.timers.tick(1)
    commands.hydra([
      'create',
      'alpha',
    ])
    t.mock.timers.tick(1)
    commands.hydra([
      'create',
      'mu',
    ])
    t.mock.timers.reset()
    const listed = () => listHydras().filter(hydra => [
      'zeta',
      'alpha',
      'mu',
    ].includes(hydra.id))
      .map(hydra => hydra.id)
    assert.deepEqual(
      listed(),
      [
        'zeta',
        'alpha',
        'mu',
      ],
    )
    const zeta = listHydras().find(hydra => hydra.id === 'zeta')
    const alpha = listHydras().find(hydra => hydra.id === 'alpha')
    assert.ok(zeta)
    assert.ok(alpha)
    editHydra({
      id: 'mu',
      position: (zeta.order + alpha.order) / 2,
    })
    assert.deepEqual(
      listed(),
      [
        'zeta',
        'mu',
        'alpha',
      ],
    )
    commands.hydra([
      'set',
      '--hydra',
      'alpha',
      '--position',
      '0',
    ])
    assert.deepEqual(
      listed(),
      [
        'alpha',
        'zeta',
        'mu',
      ],
    )
    assert.throws(
      () => commands.hydra([
        'set',
        '--hydra',
        'mu',
        '--position',
        'first',
      ]),
      /--position must be a number/,
    )
  },
)
