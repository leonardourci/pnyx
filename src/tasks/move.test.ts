import assert from 'node:assert/strict'
import { refuseEvents } from '#test-harness/database.ts'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { commands } from '#app/cli.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { project } from '#projects/cli.ts'
import { withWriter } from '#app/writer.ts'
import { appendNote, harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { decidePush } from './push.ts'
import { offerHost } from '#app/server-state.ts'
import { readEvents } from '#app/event-log.ts'
import { decideReply } from '#workers/reply-rules.ts'

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
    withWriter({
      hydraId: 'src',
      fn: ({ writer }) => {
        const decision = decideReply({
          state: writer.state,
          ref: before.id,
          data: {
            reply: 'before-move',
            state: 'delivered',
            route: 'pnyx',
            text: 'Replied before the move',
          },
          meta: {
            actor: 'web',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const working = card({
      hydraId: 'src',
      key: 'ship',
    })!

    process.env.PNYX_ACTOR = `worker:${before.id}`

    try {
      for (const actor of [
        [],
        [
          '--actor',
          'cli',
        ],
      ]) {
        assert.equal(
          (await refusal({
            args: [
              ...move({ id: before.id }),
              ...actor,
            ],
          })).code,
          'OWNER_ONLY',
        )
      }
    } finally {
      delete process.env.PNYX_ACTOR
    }

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
    assert.match(
      JSON.stringify(await task({
        args: [
          'chat',
          before.id,
          '--hydra',
          'dst',
        ],
      })),
      /Replied before the move/,
    )

    const again = await refusal({ args: move({ id: before.id }) })
    assert.match(
      again.message,
      /moved to Hydra dst/,
    )
    assert.ok(again.fix.includes(`pnyx-axi task move ${before.id} --to-hydra dst --hydra dst`))

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
    await assert.rejects(
      async () => {
        await commands.undo([
          String(moved.event),
          '--hydra',
          'dst',
        ])
      },
      /already back on Hydra src/,
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

    for (const cursor of [
      'dst:soon',
      'dst:',
      '1e3',
    ]) {
      assert.equal(
        (await refusal({
          args: [
            'history',
            before.id,
            '--before',
            cursor,
            '--hydra',
            'src',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
    }

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

// Runs a move whose source write fails after the target's committed, as a crash between the two would leave it.
async function cutMove({ id }: { id: string }) {
  const release = refuseEvents({ type: 'task.moved-out' })

  try {
    await assert.rejects(
      task({ args: move({ id }) }),
      /Postgres: refused task.moved-out/,
    )
  } finally {
    release()
  }

  // The target's arrival, which the cut left committed.
  return readEvents({ hydraId: 'dst' }).findLast(event => event.type === 'task.moved-in' && event.cardId === id)
}

test(
  'a move cut after the target wrote its line finishes when run again, carrying source edits made since, and refuses once the target copy changed',
  async t => {
    const { app } = await setup({ t })
    await attach({
      path: app,
      hydraId: 'dst',
    })
    const [
      ship,
      other,
    ] = [
      await create({
        key: 'ship',
        flags: [
          '--project',
          app,
        ],
      }),
      await create({
        key: 'other',
        flags: [
          '--project',
          app,
        ],
      }),
    ]

    const arrival = await cutMove({ id: ship.id })
    assert.ok(arrival)
    assert.ok(card({
      hydraId: 'src',
      key: 'ship',
    }))
    await task({
      args: [
        'brief',
        ship.id,
        '--brief',
        'Edited after the cut',
        '--hydra',
        'src',
      ],
    })

    const finished = await task({ args: move({ id: ship.id }) })
    assert.notEqual(
      finished.event,
      arrival.id,
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
      })?.brief,
      'Edited after the cut',
    )
    const history = await task({
      args: [
        'history',
        ship.id,
        '--hydra',
        'dst',
      ],
    }) as {
      events: {
        hydra: string
        type: string
      }[]
    }
    assert.deepEqual(
      history.events.slice(
        0,
        2,
      ).map(e => `${e.hydra} ${e.type}`),
      [
        'dst task.moved-in',
        'src task.moved-out',
      ],
    )

    await cutMove({ id: other.id })
    await task({
      args: [
        'brief',
        other.id,
        '--brief',
        'Edited on the target',
        '--hydra',
        'dst',
      ],
    })
    const both = await refusal({ args: move({ id: other.id }) })
    assert.match(
      both.message,
      /was cut short, and its copy on Hydra dst has changed since/,
    )
    assert.ok(both.fix.includes(`pnyx-axi task hide ${other.id}`))
    assert.ok(card({
      hydraId: 'src',
      key: 'other',
    }))
  },
)

test(
  'a project of the same name on the target does not stand in for the task\'s own',
  async t => {
    const {
      dir,
      app,
    } = await setup({ t })
    const twin = join(
      dir,
      'elsewhere',
      'app',
    )
    mkdirSync(
      twin,
      { recursive: true },
    )
    execFileSync(
      'git',
      [
        'init',
        '-q',
        twin,
      ],
    )
    await attach({
      path: twin,
      hydraId: 'dst',
    })
    const ship = await create({
      key: 'ship',
      flags: [
        '--project',
        app,
      ],
    })
    // The card read is live, so keep the project path it had before the rename.
    const path = ship.project
    await task({
      args: [
        'rename',
        ship.id,
        '--project',
        'app',
        '--hydra',
        'src',
      ],
    })
    assert.equal(
      card({
        hydraId: 'src',
        key: 'ship',
      })?.project,
      'app',
    )
    const refused = await refusal({ args: move({ id: ship.id }) })
    assert.equal(
      refused.code,
      'NOT_FOUND',
    )
    assert.ok(refused.fix.includes(`pnyx-axi project add ${path} --hydra dst`))
  },
)

test(
  'undo after the task moved on names the Hydra that holds it now',
  async t => {
    const { app } = await setup({ t })
    await commands.hydra([
      'create',
      'far',
    ])

    for (const hydraId of [
      'dst',
      'far',
    ]) {
      await attach({
        path: app,
        hydraId,
      })
    }

    const ship = await create({
      key: 'ship',
      flags: [
        '--project',
        app,
      ],
    })
    const first = await task({ args: move({ id: ship.id }) })

    const hint = async ({ hydraId }: { hydraId: string }) => {
      try {
        await commands.undo([
          String(first.event),
          '--hydra',
          hydraId,
        ])
      } catch (error) {
        return (error as Error).message
      }

      assert.fail('undo of a move succeeded')
    }

    const hops = async ({ path }: { path: string[][] }) => {
      for (const [
        from,
        to,
      ] of path) {
        await task({
          args: move({
            id: ship.id,
            from: from!,
            to: to!,
          }),
        })
      }
    }

    const fix = `pnyx-axi task move ${ship.id} --to-hydra src --hydra far`

    // src -> dst -> far: src last sent it to dst, but far holds it.
    await hops({
      path: [
        [
          'dst',
          'far',
        ],
      ],
    })
    assert.ok((await hint({ hydraId: 'src' })).includes(fix))

    // src -> dst -> src -> far: dst last sent it back to src, which sent it on to far.
    await hops({
      path: [
        [
          'far',
          'dst',
        ],
        [
          'dst',
          'src',
        ],
        [
          'src',
          'far',
        ],
      ],
    })
    assert.ok((await hint({ hydraId: 'dst' })).includes(fix))
  },
)

test(
  'finishing an interrupted move releases the source worker first and waits while it is busy',
  async t => {
    const {
      dir,
      app,
    } = await setup({ t })
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
    const file = join(
      dir,
      'hosted.json',
    )
    writeFileSync(
      file,
      JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'hosted-session',
          host: 'pnyx',
        },
        activity: 'finished',
      }),
    )
    await commands.push([
      '--key',
      'ship',
      '--file',
      file,
      '--hydra',
      'src',
    ])
    // A stand-in for the server's host of Hydra src, which answers each release as the test says.
    const released: string[] = []
    let answer: Record<string, unknown> = { released: 1 }
    const withdraw = offerHost({
      hydraId: 'src',
      ask: async ({ body }) => {
        released.push(String(body.task))

        return answer
      },
    })
    t.after(withdraw)

    await cutMove({ id: ship.id })
    released.length = 0

    answer = { busy: 'mid-turn' }
    assert.match(
      (await refusal({ args: move({ id: ship.id }) })).message,
      /worker is mid-turn/,
    )
    assert.ok(card({
      hydraId: 'src',
      key: 'ship',
    }))

    answer = { released: 1 }
    await task({ args: move({ id: ship.id }) })
    assert.deepEqual(
      released,
      [
        ship.id,
        ship.id,
      ],
    )
    assert.equal(
      card({
        hydraId: 'src',
        key: 'ship',
      }),
      undefined,
    )
  },
)

test(
  'a moved task\'s notes are harvested once: the target reads its transcript on from where the source stopped',
  async t => {
    const { dir } = await setup({ t })
    await create({ key: 'noted' })
    const transcript = join(
      dir,
      'session.jsonl',
    )
    copyFileSync(
      fileURLToPath(new URL(
        '../hydra/fixtures/transcripts/claude-notes.jsonl',
        import.meta.url,
      )),
      transcript,
    )
    withWriter({
      hydraId: 'src',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          key: 'noted',
          input: {
            agent: {
              provider: 'claude',
              sessionId: 'noted-session',
              host: 'pnyx',
              transcriptPath: transcript,
            },
            activity: 'finished',
          },
          meta: {
            actor: 'web',
            at: '2026-10-11T09:00:00.000Z',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
      },
    })
    const id = card({
      hydraId: 'src',
      key: 'noted',
    })!.id
    const withdraw = offerHost({
      hydraId: 'src',
      ask: async () => ({ released: 1 }),
    })

    try {
      await task({ args: move({ id }) })
    } finally {
      withdraw()
    }

    const moved = loadHydra({ hydraId: 'dst' }).state.cards[id]!.notes!.map(note => note.id)
    assert.ok(moved.length)
    assert.equal(
      withWriter({
        hydraId: 'dst',
        fn: ({ writer }) => harvestTranscripts({
          writer,
          cardIds: [id],
          at: '2026-10-11T10:00:00.000Z',
        }),
      }),
      0,
    )
    await task({
      args: [
        'status',
        id,
        'working',
        '--note',
        'after the move',
        '--hydra',
        'dst',
      ],
    })
    assert.deepEqual(
      loadHydra({ hydraId: 'dst' }).state.cards[id]!.notes!.map(note => note.id),
      moved,
    )
  },
)
