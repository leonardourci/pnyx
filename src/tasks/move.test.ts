import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { project } from '#projects/cli.ts'

const INHERITED = [
  'PNYX_HOME',
  'PNYX_ACTOR',
  'PNYX_TASK',
  'PNYX_HYDRA',
]

function home({ t }: { t: TestContext }): string {
  const saved = INHERITED.map(name => [
    name,
    process.env[name],
  ] as const)
  const dir = mkdtempSync(join(
    tmpdir(),
    'pnyx-move-',
  ))

  for (const name of INHERITED) {
    delete process.env[name]
  }

  process.env.PNYX_HOME = join(
    dir,
    'home',
  )
  t.after(() => {
    for (const [
      name,
      value,
    ] of saved) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }

    rmSync(
      dir,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return dir
}

const card = ({
  hydraId,
  key,
}: {
  hydraId: string
  key: string
}) => {
  const { state } = loadHydra({ hydraId })

  return state.cards[state.keys[key] ?? '']
}

// A project another Hydra already has needs the owner's confirmation to share.
async function attach({
  path,
  hydraId,
}: {
  path: string
  hydraId: string
}) {
  const args = [
    'add',
    path,
    '--hydra',
    hydraId,
  ]
  const first = await project(args) as { token?: string }

  if (first.token) {
    await project([
      ...args,
      '--confirm',
      first.token,
    ])
  }
}

// The refusal's message, and its one suggestion: the command that clears it.
async function refusal({ args }: { args: string[] }) {
  try {
    await commands.task(args)
  } catch (error) {
    const {
      message,
      suggestions,
    } = error as Error & { suggestions: string[] }

    return {
      message,
      fix: suggestions.join(' '),
    }
  }

  assert.fail(`pnyx-axi task ${args.join(' ')} succeeded`)
}

const move = ({
  id,
  from = 'src',
  to = 'dst',
}: {
  id: string
  from?: string
  to?: string
}) => [
  'move',
  id,
  '--to-hydra',
  to,
  '--hydra',
  from,
]

test(
  'a task moves only once nothing ties it to the Hydra it leaves, and each refusal names the command that clears it',
  async t => {
    const dir = home({ t })
    const app = join(
      dir,
      'app',
    )
    mkdirSync(app)
    execFileSync(
      'git',
      [
        'init',
        '-q',
        app,
      ],
    )

    for (const id of [
      'src',
      'dst',
    ]) {
      await commands.hydra([
        'create',
        id,
      ])
    }

    await attach({
      path: app,
      hydraId: 'src',
    })

    for (const key of [
      'ship',
      'base',
      'parent',
    ]) {
      await commands.task([
        'create',
        '--title',
        key,
        '--key',
        key,
        '--project',
        app,
        '--hydra',
        'src',
      ])
    }

    await commands.task([
      'create',
      '--title',
      'child',
      '--key',
      'child',
      '--parent',
      card({
        hydraId: 'src',
        key: 'parent',
      })!.id,
      '--hydra',
      'src',
    ])
    const ship = card({
      hydraId: 'src',
      key: 'ship',
    })!
    const base = card({
      hydraId: 'src',
      key: 'base',
    })!

    const noProject = await refusal({ args: move({ id: ship.id }) })
    assert.match(
      noProject.message,
      /Hydra dst has no project .* attached/,
    )
    assert.match(
      noProject.fix,
      new RegExp(`pnyx-axi project add ${ship.project} --hydra dst`),
    )
    await attach({
      path: app,
      hydraId: 'dst',
    })

    await commands.task([
      'depend',
      ship.id,
      '--on',
      base.id,
      '--hydra',
      'src',
    ])
    assert.match(
      (await refusal({ args: move({ id: ship.id }) })).fix,
      new RegExp(`pnyx-axi task undepend ${ship.id} --on ${base.id} --hydra src`),
    )
    await commands.task([
      'undepend',
      ship.id,
      '--on',
      base.id,
      '--hydra',
      'src',
    ])

    await commands.task([
      'depend',
      base.id,
      '--on',
      ship.id,
      '--hydra',
      'src',
    ])
    assert.match(
      (await refusal({ args: move({ id: ship.id }) })).fix,
      new RegExp(`pnyx-axi task undepend ${base.id} --on ${ship.id} --hydra src`),
    )
    await commands.task([
      'undepend',
      base.id,
      '--on',
      ship.id,
      '--hydra',
      'src',
    ])

    assert.match(
      (await refusal({
        args: move({
          id: card({
            hydraId: 'src',
            key: 'child',
          })!.id,
        }),
      })).message,
      /is a subtask of/,
    )

    const lease = join(
      process.env.PNYX_HOME!,
      'hydras',
      'src',
      `helper-lease-${encodeURIComponent(ship.id)}.json`,
    )
    writeFileSync(
      lease,
      JSON.stringify({
        actor: 'helper:test',
        holders: [
          {
            id: 'test',
            pid: process.pid,
          },
        ],
      }),
    )
    assert.match(
      (await refusal({ args: move({ id: ship.id }) })).message,
      /being handled by helper:test/,
    )
    rmSync(lease)

    const file = join(
      dir,
      'hooked.json',
    )

    const hooked = ({ activity }: { activity: string }) => {
      writeFileSync(
        file,
        JSON.stringify({
          title: 'hooked',
          project: app,
          agent: {
            provider: 'claude',
            sessionId: 'terminal-session',
          },
          activity,
        }),
      )

      return commands.push([
        '--key',
        'hooked',
        '--file',
        file,
        '--hydra',
        'src',
      ])
    }

    await commands.task([
      'create',
      '--title',
      'hooked',
      '--key',
      'hooked',
      '--project',
      app,
      '--hydra',
      'src',
    ])
    await hooked({ activity: 'working' })
    const terminal = card({
      hydraId: 'src',
      key: 'hooked',
    })!
    assert.match(
      (await refusal({ args: move({ id: terminal.id }) })).message,
      /mid-turn/,
    )
    await hooked({ activity: 'idle' })
    assert.match(
      (await refusal({ args: move({ id: terminal.id }) })).fix,
      new RegExp(`pnyx-axi task detach ${terminal.id} --hydra src`),
    )

    assert.match(
      (await refusal({
        args: move({
          id: ship.id,
          to: 'src',
        }),
      })).message,
      /already on Hydra src/,
    )
  },
)

test(
  'a moved task keeps its record and history on the new Hydra, the old Hydra points to it, undo refuses and a move back works',
  async t => {
    const dir = home({ t })
    const app = join(
      dir,
      'app',
    )
    mkdirSync(app)
    execFileSync(
      'git',
      [
        'init',
        '-q',
        app,
      ],
    )

    for (const id of [
      'src',
      'dst',
    ]) {
      await commands.hydra([
        'create',
        id,
      ])
      await attach({
        path: app,
        hydraId: id,
      })
    }

    await commands.task([
      'create',
      '--title',
      'Ship',
      '--key',
      'ship',
      '--project',
      app,
      '--ask',
      'ship it',
      '--brief',
      'Build it',
      '--hydra',
      'src',
    ])
    const before = card({
      hydraId: 'src',
      key: 'ship',
    })!
    await commands.task([
      'status',
      before.id,
      'paused',
      '--note',
      'waiting on review',
      '--hydra',
      'src',
    ])

    const parked = card({
      hydraId: 'src',
      key: 'ship',
    })!
    const moved = await commands.task([
      ...move({ id: before.id }),
      '--actor',
      'hydra',
      '--reason',
      'Owner moved the project here',
    ]) as Record<string, unknown>
    assert.equal(
      moved.to,
      'dst',
    )

    const arrived = card({
      hydraId: 'dst',
      key: 'ship',
    })!
    assert.equal(
      arrived.id,
      before.id,
    )
    assert.deepEqual(
      [
        arrived.title,
        arrived.brief,
        arrived.ask?.map(a => a.text),
        arrived.status?.note,
        arrived.project,
      ],
      [
        'Ship',
        'Build it',
        ['ship it'],
        'waiting on review',
        before.project,
      ],
    )
    assert.equal(
      loadHydra({ hydraId: 'dst' }).state.config?.columns.find(c => c.id === arrived.column)?.title,
      loadHydra({ hydraId: 'src' }).state.config?.columns.find(c => c.id === parked.column)?.title,
    )

    const source = loadHydra({ hydraId: 'src' }).state
    assert.equal(
      source.cards[before.id],
      undefined,
    )
    assert.equal(
      source.movedOut?.[before.id]?.to,
      'dst',
    )
    assert.match(
      (await refusal({
        args: [
          'show',
          before.id,
          '--hydra',
          'src',
        ],
      })).fix,
      /--hydra dst/,
    )

    const history = await commands.task([
      'history',
      before.id,
      '--hydra',
      'dst',
    ]) as {
      events: {
        hydra: string
        type: string
      }[]
    }
    assert.deepEqual(
      history.events.map(e => `${e.hydra} ${e.type}`),
      [
        'dst task.moved-in',
        'src task.moved-out',
        'src card.moved',
        'src task.declared',
        'src task.created',
      ],
    )

    await assert.rejects(
      async () => {
        await commands.undo([
          String(moved.event),
          '--hydra',
          'dst',
        ])
      },
      new RegExp(`pnyx-axi task move ${before.id} --to-hydra src --hydra dst`),
    )

    await commands.task(move({
      id: before.id,
      from: 'dst',
      to: 'src',
    }))
    assert.equal(
      card({
        hydraId: 'src',
        key: 'ship',
      })?.status?.note,
      'waiting on review',
    )
    assert.equal(
      loadHydra({ hydraId: 'src' }).state.movedOut?.[before.id],
      undefined,
    )
    const back = await commands.task([
      'history',
      before.id,
      '--limit',
      '3',
      '--hydra',
      'src',
    ]) as {
      events: {
        hydra: string
        type: string
      }[]
      next: string
    }
    assert.deepEqual(
      back.events.map(e => `${e.hydra} ${e.type}`),
      [
        'src task.moved-in',
        'dst task.moved-out',
        'dst task.moved-in',
      ],
    )
    const older = await commands.task([
      'history',
      before.id,
      '--before',
      back.next,
      '--hydra',
      'src',
    ]) as {
      events: {
        hydra: string
        type: string
      }[]
    }
    assert.equal(
      older.events[0]?.type,
      'task.moved-out',
    )
    assert.equal(
      older.events[0]?.hydra,
      'src',
    )
  },
)
