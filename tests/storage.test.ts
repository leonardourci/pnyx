import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'
import { SCHEMA_VERSION, sql } from './setup/postgres.ts'
import { parsed, pnyxAxi, rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

const TABLES = [
  'hydras',
  'hydra_values',
  'events',
  'card_updates',
  'transactions',
  'columns',
  'cards',
  'card_bodies',
  'questions',
  'declarations',
  'links',
  'notes',
  'messages',
  'sessions',
]

// Everything Postgres holds for a Hydra, so a refused command can be shown to have written nothing.
const stored = ({ hydraId }: { hydraId: string }) => JSON.stringify(TABLES.map(table => rows({
  text: `select * from ${table} as row where ${table === 'hydras' ? 'id' : 'hydra_id'} = $1 order by row::text`,
  values: [hydraId],
})))

test(
  'a database another build\'s schema made is refused by name, and the server starts once it is this build\'s again',
  async () => {
    const database = homeDatabase()
    const foreign = () => sql({
      database,
      text: 'update schema_version set version = 99 where version = $1',
      values: [SCHEMA_VERSION],
    })

    await expect(pnyx.restart({
      whileStopped: async () => {
        await closePostgres()
        await foreign()
      },
    })).rejects.toThrow(new RegExp(`database ${database} has another Pnyx build's schema \\(99\\)`))
    expect((await pnyxAxi({
      args: [
        'task',
        'list',
      ],
      env: process.env,
    })).stdout).toContain('NOT_RUNNING')

    await closePostgres()
    await sql({
      database,
      text: 'update schema_version set version = $1 where version = 99',
      values: [SCHEMA_VERSION],
    })
    await pnyx.start()
    const hydra = await pnyx.hydra()
    expect((await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks).toBeDefined()
  },
)

test(
  'a refused command writes nothing, an accepted one commits its events with its rows, and a restart reloads the same tasks',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'First',
        '--key',
        'first',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Second',
        '--key',
        'second',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'depend',
        'second',
        '--on',
        'first',
      ],
    })
    const unchanged = stored({ hydraId: hydra.id })

    const invalid = await hydra.ownerRefused({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            title: 'Would be created',
            key: 'third',
          },
          {
            op: 'task.brief',
            task: 'missing-task',
            brief: 'No such task',
          },
        ],
      }),
    })
    expect(invalid.code).toBe('VALIDATION_ERROR')
    expect(stored({ hydraId: hydra.id })).toBe(unchanged)

    const applied = await hydra.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            as: 'third',
            title: 'Third',
            key: 'third',
          },
          {
            op: 'task.depend',
            task: '$third',
            on: ['second'],
          },
        ],
      }),
    })
    const third = rows<{
      id: string
      title: string
      created_seq: string
    }>({
      text: 'select id, title, created_seq from cards where hydra_id = $1 and key = \'third\'',
      values: [hydra.id],
    })
    expect(third).toEqual([
      {
        id: expect.stringMatching(/^task-/),
        title: 'Third',
        created_seq: expect.any(String),
      },
    ])
    expect(rows({
      text: 'select type from events where hydra_id = $1 and seq = $2',
      values: [
        hydra.id,
        third[0]!.created_seq,
      ],
    })).toEqual([{ type: 'task.created' }])
    expect(JSON.stringify(applied)).toContain(third[0]!.id)

    const listed = await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })
    const dependent = await hydra.task({ key: 'third' })
    await pnyx.restart()
    expect(await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).toEqual(listed)
    expect(await hydra.task({ key: 'third' })).toEqual(dependent)
    expect(dependent.readiness.ready).toBe(false)
  },
)

test(
  'a write that started before another writer moved the Hydra\'s seq is not committed over it, and no event is lost or repeated',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'First',
        '--key',
        'first',
      ],
    })
    const seq = () => Number(rows<{ seq: string }>({
      text: 'select seq from hydras where id = $1',
      values: [hydra.id],
    })[0]!.seq)
    const events = () => rows<{ seq: string }>({
      text: 'select seq from events where hydra_id = $1 order by seq',
      values: [hydra.id],
    }).map(event => Number(event.seq))
    const before = events()

    // Another writer got in between: the server's copy of the Hydra is now behind the database.
    const ahead = seq() + 5
    rows({
      text: 'update hydras set seq = $2 where id = $1',
      values: [
        hydra.id,
        ahead,
      ],
    })

    const create = [
      'task',
      'create',
      '--title',
      'Second',
      '--key',
      'second',
    ]
    expect((await hydra.ownerRefused({ args: create })).code).toBe('CONFLICT')
    expect(seq()).toBe(ahead)
    expect(events()).toEqual(before)

    // The server reloads the Hydra from the database, so the same command then commits after the other writer's change.
    await hydra.owner({ args: create })
    expect(seq()).toBeGreaterThan(ahead)
    expect(events()).toHaveLength(before.length + 1)
    expect(new Set(events()).size).toBe(events().length)
  },
)

// The log an older Pnyx kept: one event per line.
const legacyEvent = ({
  seq,
  key,
}: {
  seq: number
  key: string
}) => `${JSON.stringify({
  v: 1,
  seq,
  id: `evt_${seq}`,
  at: '2026-10-21T10:01:00Z',
  actor: 'cli',
  cardId: `task-${key}`,
  type: 'task.created',
  data: {
    key,
    title: `Task ${key}`,
  },
})}\n`

const legacyLog = ({ id }: { id: string }) => {
  const dir = join(
    process.env.PNYX_HOME!,
    'hydras',
    id,
  )
  mkdirSync(
    dir,
    { recursive: true },
  )

  return join(
    dir,
    'events.jsonl',
  )
}

test(
  'a legacy events.jsonl is imported once when its Hydra is first served, and stays a backup',
  async () => {
    const path = legacyLog({ id: 'legacy-once' })
    const log = legacyEvent({
      seq: 1,
      key: 'old',
    }) + legacyEvent({
      seq: 2,
      key: 'older',
    })
    writeFileSync(
      path,
      log,
    )
    const hydra = await pnyx.hydra({
      id: 'legacy-once',
      create: false,
    })

    const listed = async () => (await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks.map((task: { title: string }) => task.title).sort()
    expect(await listed()).toEqual([
      'Task old',
      'Task older',
    ])
    const imported = () => rows<{ seq: string }>({
      text: 'select seq from events where hydra_id = $1 order by seq',
      values: [hydra.id],
    }).map(event => Number(event.seq))
    expect(imported().slice(
      0,
      2,
    )).toEqual([
      1,
      2,
    ])

    await pnyx.restart()
    expect(await listed()).toEqual([
      'Task old',
      'Task older',
    ])
    expect(imported().slice(
      0,
      2,
    )).toEqual([
      1,
      2,
    ])
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(log)
  },
)

test(
  'a legacy log with a torn tail is refused with its sizes, and one an older Pnyx appended to after the import is refused too',
  async () => {
    const torn = legacyLog({ id: 'legacy-torn' })
    writeFileSync(
      torn,
      `${legacyEvent({
        seq: 1,
        key: 'old',
      })}{"v":1,"seq":2`,
    )
    await expect(pnyx.open({ id: 'legacy-torn' })).rejects.toThrow(/torn tail of 14 bytes/)
    expect(rows({
      text: 'select 1 from hydras where id = \'legacy-torn\'',
    })).toEqual([])
    // The server keeps polling a Hydra folder it could not load, so the refused log leaves with the test.
    rmSync(
      dirname(torn),
      { recursive: true },
    )

    const grown = legacyLog({ id: 'legacy-grown' })
    writeFileSync(
      grown,
      legacyEvent({
        seq: 1,
        key: 'old',
      }),
    )
    await pnyx.hydra({
      id: 'legacy-grown',
      create: false,
    })
    const imported = statSync(grown).size
    appendFileSync(
      grown,
      legacyEvent({
        seq: 2,
        key: 'later',
      }),
    )
    await pnyx.restart()
    const health = await (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).json() as { skipped: Record<string, string> }
    expect(health.skipped['legacy-grown']).toContain(`${imported} bytes then`)
    expect(statSync(grown).size).toBeGreaterThan(imported)
    rmSync(
      dirname(grown),
      { recursive: true },
    )
  },
)

test(
  'text holding a NUL or a lone surrogate is stored with U+FFFD in its place, and later writes still succeed',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'push',
        '--key',
        'odd',
        '--file',
        '-',
      ],
      input: '{"title": "before\\u0000after \\ud800 end"}',
    })
    expect((await hydra.task({ key: 'odd' })).title).toBe('before�after � end')

    await hydra.owner({
      args: [
        'task',
        'rename',
        'odd',
        '--title',
        'Plain again',
      ],
    })
    expect((await hydra.task({ key: 'odd' })).title).toBe('Plain again')
  },
)

// Stops the servers this test started and the zero-cache each leads in a group of its own; nothing else is touched.
function stopServe({ children }: { children: ChildProcess[] }) {
  const listing = spawnSync(
    '/bin/ps',
    [
      '-axo',
      'pid=,ppid=,pgid=',
    ],
    { encoding: 'utf8' },
  ).stdout

  for (const child of children) {
    for (const line of listing.split('\n')) {
      const [
        pid,
        parent,
        group,
      ] = line.trim().split(/\s+/)
        .map(Number)

      if (parent === child.pid && pid === group) {
        try {
          process.kill(
            -pid!,
            'SIGKILL',
          )
        } catch {
          // Already gone.
        }
      }
    }

    child.kill('SIGKILL')
  }
}

// The built `pnyx-axi serve` as a process of its own, on a home of its own.
const SERVE = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

test(
  'the real serve entry keeps what it accepted across kill -9, and a second serve on the same home is refused while the first runs',
  async () => {
    const home = join(
      process.env.TMPDIR!,
      'serve-home',
    )
    const env = {
      ...process.env,
      PNYX_HOME: home,
    }
    const children: ChildProcess[] = []

    const serve = async () => {
      const child = spawn(
        process.execPath,
        [
          SERVE,
          'serve',
          '--port',
          '0',
        ],
        { env },
      )
      children.push(child)
      let out = ''
      child.stdout.on(
        'data',
        data => out += String(data),
      )
      let err = ''
      child.stderr.on(
        'data',
        data => err += String(data),
      )
      const ended = new Promise<void>(resolve => child.once(
        'exit',
        () => resolve(),
      ))
      const url = await until({
        what: 'serve to print its address',
        timeoutMs: 30_000,
        check: () => /^url: "(.+)"$/m.exec(out)?.[1],
      }).catch((error: Error) => {
        throw new Error(`${error.message}\n${out}${err}`)
      })

      return {
        child,
        url,
        ended,
      }
    }

    const cli = ({ args }: { args: string[] }) => pnyxAxi({
      args,
      env,
    })

    try {
      const first = await serve()
      expect((await cli({
        args: [
          'task',
          'create',
          '--title',
          'Kept',
          '--key',
          'kept',
        ],
      })).status).toBe(0)
      first.child.kill('SIGKILL')
      await first.ended

      const second = await serve()
      const kept = await cli({
        args: [
          'task',
          'show',
          'kept',
        ],
      })
      expect(kept.status).toBe(0)
      expect(parsed(kept).task.title).toBe('Kept')

      const third = spawn(
        process.execPath,
        [
          SERVE,
          'serve',
          '--port',
          '0',
        ],
        { env },
      )
      children.push(third)
      let refusal = ''
      third.stdout.on(
        'data',
        data => refusal += String(data),
      )
      await new Promise(resolve => third.once(
        'exit',
        resolve,
      ))
      expect(refusal).toContain('code: ALREADY_RUNNING')
      expect(second.child.exitCode).toBeNull()
      expect((await cli({
        args: [
          'task',
          'show',
          'kept',
        ],
      })).status).toBe(0)
    } finally {
      stopServe({ children })
    }
  },
)
