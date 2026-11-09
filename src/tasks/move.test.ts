import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '#app/cli.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { project } from '#projects/cli.ts'
import { withWriter } from '#app/writer.ts'
import { appendNote } from '#integrations/hooks/harvest.ts'

const INHERITED = [
  'PNYX_HOME',
  'PNYX_ACTOR',
  'PNYX_TASK',
  'PNYX_HYDRA',
]

// A temporary home with a git project attached to Hydra src, and an empty Hydra dst.
async function setup({ t }: { t: TestContext }) {
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

  return {
    dir,
    app,
  }
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

async function create({
  key,
  hydraId = 'src',
  flags = [],
}: {
  key: string
  hydraId?: string
  flags?: string[]
}) {
  await commands.task([
    'create',
    '--title',
    key,
    '--key',
    key,
    ...flags,
    '--hydra',
    hydraId,
  ])

  return card({
    hydraId,
    key,
  })!
}

const task = async ({ args }: { args: string[] }) =>
  await commands.task(args) as Record<string, unknown>

// The refusal's code, message and its one suggestion: the command that clears it.
async function refusal({ args }: { args: string[] }) {
  try {
    await commands.task(args)
  } catch (error) {
    const {
      code,
      message,
      suggestions,
    } = error as Error & {
      code: string
      suggestions: string[]
    }

    return {
      code,
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

const columnTitle = ({
  hydraId,
  column,
}: {
  hydraId: string
  column: string
}) => loadHydra({ hydraId }).state.config?.columns.find(c => c.id === column)?.title

test(
  'a task moves only once nothing ties it to the Hydra it leaves, and each refusal names the command that clears it',
  async t => {
    const {
      dir,
      app,
    } = await setup({ t })
    const ship = await create({
      key: 'ship',
      flags: [
        '--project',
        app,
      ],
    })
    const base = await create({ key: 'base' })
    const rerun = `pnyx-axi task move ${ship.id} --to-hydra dst --hydra src`
    const refused = ({ id = ship.id }: { id?: string } = {}) => refusal({ args: move({ id }) })

    const unknown = await refusal({
      args: move({
        id: ship.id,
        to: 'nowhere',
      }),
    })
    assert.equal(
      unknown.code,
      'NOT_FOUND',
    )
    assert.ok(unknown.fix.includes('pnyx-axi hydra list'))

    const noProject = await refused()
    assert.equal(
      noProject.code,
      'NOT_FOUND',
    )
    assert.ok(noProject.fix.includes(`pnyx-axi project add ${ship.project} --hydra dst`))
    assert.ok(noProject.fix.includes(rerun))
    await attach({
      path: app,
      hydraId: 'dst',
    })

    for (const [
      blocked,
      by,
    ] of [
        [
          ship,
          base,
        ],
        [
          base,
          ship,
        ],
      ]) {
      await task({
        args: [
          'depend',
          blocked.id,
          '--on',
          by.id,
          '--hydra',
          'src',
        ],
      })
      assert.ok((await refused()).fix.includes(`pnyx-axi task undepend ${blocked.id} --on ${by.id} --hydra src`))
      await task({
        args: [
          'undepend',
          blocked.id,
          '--on',
          by.id,
          '--hydra',
          'src',
        ],
      })
    }

    for (const [
      waiter,
      on,
    ] of [
        [
          ship,
          base,
        ],
        [
          base,
          ship,
        ],
      ]) {
      await task({
        args: [
          'status',
          waiter.id,
          'paused',
          '--wait-for',
          on.id,
          '--hydra',
          'src',
        ],
      })
      assert.ok((await refused()).fix.includes(`pnyx-axi task status ${waiter.id} paused --hold`))
      await task({
        args: [
          'status',
          waiter.id,
          'paused',
          '--hold',
          '--note',
          'wait over',
          '--hydra',
          'src',
        ],
      })
    }

    const parent = await create({ key: 'parent' })
    const child = await create({
      key: 'child',
      flags: [
        '--parent',
        parent.id,
      ],
    })
    assert.match(
      (await refused({ id: child.id })).message,
      /is a subtask of/,
    )
    assert.match(
      (await refused({ id: parent.id })).message,
      new RegExp(`has subtask ${child.id}`),
    )

    const lease = join(
      hydraDir({ hydraId: 'src' }),
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
    assert.equal(
      (await refused()).code,
      'TASK_LEASED',
    )
    rmSync(lease)

    const hooked = await create({
      key: 'hooked',
      flags: [
        '--project',
        app,
      ],
    })
    const file = join(
      dir,
      'hooked.json',
    )

    const push = async ({ activity }: { activity: string }) => {
      writeFileSync(
        file,
        JSON.stringify({
          agent: {
            provider: 'claude',
            sessionId: 'terminal-session',
          },
          activity,
        }),
      )
      await commands.push([
        '--key',
        'hooked',
        '--file',
        file,
        '--hydra',
        'src',
      ])
    }

    await push({ activity: 'working' })
    assert.match(
      (await refused({ id: hooked.id })).message,
      /mid-turn/,
    )
    await push({ activity: 'idle' })
    assert.ok((await refused({ id: hooked.id })).fix.includes(`pnyx-axi task detach ${hooked.id} --hydra src`))

    await create({
      key: 'ship',
      hydraId: 'dst',
    })
    assert.match(
      (await refused()).message,
      /already has a task with id or key/,
    )

    const home = join(
      dir,
      'firstmate',
    )
    mkdirSync(
      join(
        home,
        'tasks',
      ),
      { recursive: true },
    )
    await commands.hydra([
      'create',
      'mate',
      '--firstmate',
      home,
    ])
    assert.match(
      (await refusal({
        args: move({
          id: ship.id,
          to: 'mate',
        }),
      })).message,
      /follows a Firstmate home/,
    )

    assert.equal(
      (await refusal({
        args: move({
          id: ship.id,
          to: 'src',
        }),
      })).code,
      'VALIDATION_ERROR',
    )
    assert.ok(card({
      hydraId: 'src',
      key: 'ship',
    }))
  },
)

test(
  'a moved task keeps its record, column and history on the new Hydra, the old Hydra points to it, undo refuses on both sides and a move back works',
  async t => {
    const { app } = await setup({ t })
    await attach({
      path: app,
      hydraId: 'dst',
    })
    const before = await create({
      key: 'ship',
      flags: [
        '--project',
        app,
        '--ask',
        'ship it',
        '--brief',
        'Build it',
      ],
    })
    await task({
      args: [
        'status',
        before.id,
        'working',
        '--note',
        'building',
        '--hydra',
        'src',
      ],
    })
    withWriter({
      hydraId: 'src',
      fn: ({ writer }) => appendNote({
        writer,
        cardId: before.id,
        note: {
          ref: 'decision-1',
          kind: 'decision',
          source: 'test',
          text: 'Use the shared lock',
        },
        at: new Date().toISOString(),
      }),
    })
    const working = card({
      hydraId: 'src',
      key: 'ship',
    })!

    const moved = await task({
      args: [
        ...move({ id: before.id }),
        '--actor',
        'hydra',
        '--reason',
        'Owner moved the project here',
      ],
    })
    const arrived = card({
      hydraId: 'dst',
      key: 'ship',
    })!
    assert.deepEqual(
      [
        arrived.id,
        arrived.title,
        arrived.brief,
        arrived.ask?.map(a => a.text),
        arrived.status?.note,
        arrived.project,
      ],
      [
        before.id,
        'ship',
        'Build it',
        ['ship it'],
        'building',
        before.project,
      ],
    )
    assert.notEqual(
      arrived.column,
      loadHydra({ hydraId: 'dst' }).state.config?.columns.find(c => c.role === 'parked')?.id,
    )
    assert.equal(
      columnTitle({
        hydraId: 'dst',
        column: arrived.column,
      }),
      columnTitle({
        hydraId: 'src',
        column: working.column,
      }),
    )

    assert.deepEqual(
      await task({
        args: [
          ...move({ id: before.id }),
          '--event-id',
          String(moved.event),
        ],
      }),
      {
        moved: before.id,
        to: 'dst',
        event: moved.event,
        state: 'unchanged',
      },
    )

    assert.match(
      JSON.stringify(await commands.card([
        before.id,
        '--hydra',
        'dst',
      ])),
      /Use the shared lock/,
    )

    for (const ref of [
      before.id,
      'ship',
    ]) {
      const stale = await refusal({
        args: [
          'show',
          ref,
          '--hydra',
          'src',
        ],
      })
      assert.match(
        stale.message,
        /moved to Hydra dst/,
      )
      assert.ok(stale.fix.includes('--hydra dst'))
    }

    // The saved snapshot is only a cache: the logs alone give the same Hydras.
    for (const hydraId of [
      'src',
      'dst',
    ]) {
      rmSync(join(
        hydraDir({ hydraId }),
        'snapshot.json',
      ))
    }

    assert.equal(
      loadHydra({ hydraId: 'src' }).state.cards[before.id],
      undefined,
    )
    assert.equal(
      card({
        hydraId: 'dst',
        key: 'ship',
      })?.status?.note,
      'building',
    )

    const history = await task({
      args: [
        'history',
        before.id,
        '--hydra',
        'dst',
      ],
    }) as {
      events: {
        hydra: string
        type: string
      }[]
    }
    const rows = history.events.map(e => `${e.hydra} ${e.type}`)
    assert.deepEqual(
      rows.slice(
        0,
        2,
      ),
      [
        'dst task.moved-in',
        'src task.moved-out',
      ],
    )
    assert.equal(
      rows.at(-1),
      'src task.created',
    )

    for (const hydraId of [
      'dst',
      'src',
    ]) {
      await assert.rejects(
        async () => {
          await commands.undo([
            String(moved.event),
            '--hydra',
            hydraId,
          ])
        },
        new RegExp(`pnyx-axi task move ${before.id} --to-hydra src --hydra dst`),
      )
    }

    await task({
      args: move({
        id: before.id,
        from: 'dst',
        to: 'src',
      }),
    })
    assert.equal(
      card({
        hydraId: 'src',
        key: 'ship',
      })?.status?.note,
      'building',
    )
    assert.equal(
      loadHydra({ hydraId: 'src' }).state.movedOut?.[before.id],
      undefined,
    )
    const back = await task({
      args: [
        'history',
        before.id,
        '--limit',
        '3',
        '--hydra',
        'src',
      ],
    }) as {
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
    const older = await task({
      args: [
        'history',
        before.id,
        '--before',
        String(back.next),
        '--hydra',
        'src',
      ],
    }) as {
      events: {
        hydra: string
        type: string
      }[]
    }
    assert.equal(
      `${older.events[0]?.hydra} ${older.events[0]?.type}`,
      'src task.moved-out',
    )
    assert.equal(
      (await refusal({
        args: [
          'history',
          before.id,
          '--before',
          'dst:soon',
          '--hydra',
          'src',
        ],
      })).code,
      'VALIDATION_ERROR',
    )

    assert.equal(
      (await refusal({
        args: [
          ...move({ id: before.id }),
          '--event-id',
          String(moved.event),
        ],
      })).code,
      'IDEMPOTENCY_CONFLICT',
    )
  },
)

test(
  'a move cut after the target wrote its line is finished by running it again',
  async t => {
    const { app } = await setup({ t })
    await attach({
      path: app,
      hydraId: 'dst',
    })
    const ship = await create({
      key: 'ship',
      flags: [
        '--project',
        app,
      ],
    })
    const moved = await task({ args: move({ id: ship.id }) })
    const log = join(
      hydraDir({ hydraId: 'src' }),
      'events.jsonl',
    )
    const lines = readFileSync(
      log,
      'utf8',
    ).trimEnd()
      .split('\n')
    writeFileSync(
      log,
      `${lines.slice(
        0,
        -1,
      ).join('\n')}\n`,
    )
    rmSync(join(
      hydraDir({ hydraId: 'src' }),
      'snapshot.json',
    ))
    assert.ok(card({
      hydraId: 'src',
      key: 'ship',
    }))

    const finished = await task({ args: move({ id: ship.id }) })
    assert.equal(
      finished.event,
      moved.event,
    )
    assert.equal(
      card({
        hydraId: 'src',
        key: 'ship',
      }),
      undefined,
    )
    assert.equal(
      card({
        hydraId: 'dst',
        key: 'ship',
      })?.id,
      ship.id,
    )
  },
)
