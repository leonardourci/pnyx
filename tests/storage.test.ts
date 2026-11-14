import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { beforeAll, expect, test } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'
import { binaries } from './setup/postgres.ts'
import { pnyxAxi, rows, startPnyx, type Hydra, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// The live Hydras #378's schema held when its migration failed: 229,279 events, 121,543 of them repeat observations.
const OBSERVATIONS = 121_543
const TRANSCRIPT_COPIES = 6_000
const KEPT = 101_736
// What #378 shipped, so the migration runs from the database a real install has.
const SCHEMA_1 = readFileSync(
  join(
    import.meta.dirname,
    'setup',
    'fixtures',
    'schema-1.sql',
  ),
  'utf8',
)

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

// One statement on a database of the run's cluster, outside Pnyx's own connection.
async function sql({
  database,
  text,
  values,
}: {
  database: string
  text: string
  values?: unknown[]
}) {
  const client = new pg.Client({ database })
  await client.connect()

  try {
    return (await client.query(
      text,
      values,
    )).rows
  } finally {
    await client.end()
  }
}

// count copies of one event after seq from, each listed in the card's Updates.
async function bulk({
  database,
  hydraId,
  type,
  card,
  count,
  from,
  data,
}: {
  database: string
  hydraId: string
  type: string
  card: string
  count: number
  from: number
  data: string
}) {
  const values = [
    hydraId,
    from,
    type,
    card,
    count,
  ]
  await sql({
    database,
    values,
    text: `insert into events (hydra_id, seq, id, type, at, actor, card_id, data)
      select $1::text, $2::bigint + n, $3::text || n, $3::text, at, 'hook:claude', $4::text, json_build_object('v', 1,
        'id', $3::text || n, 'seq', $2::bigint + n, 'type', $3::text, 'cardId', $4::text, 'actor', 'hook:claude', 'at', at,
        'data', ${data})
      from generate_series(1, $5::integer) as n,
        lateral (select to_char(timestamp '2026-11-01' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"') as at) as time`,
  })
  await sql({
    database,
    values: [
      hydraId,
      card,
      from,
      count,
    ],
    text: 'insert into card_updates (hydra_id, card_id, seq) select $1::text, $2::text, $3::bigint + n from generate_series(1, $4::integer) as n',
  })
}

// This home's database as #378's build left it: its schema, the server's data and a live-size history.
async function backToSchema1({
  hydraId,
  observed,
  edited,
}: {
  hydraId: string
  observed: string
  edited: string
}) {
  await closePostgres()
  const home = homeDatabase()
  const legacy = `${home}_legacy`
  const bin = binaries()
  await sql({
    database: 'postgres',
    text: `create database ${legacy}`,
  })
  await sql({
    database: legacy,
    text: SCHEMA_1,
  })
  const data = execFileSync(
    join(
      bin,
      'pg_dump',
    ),
    [
      '--data-only',
      '--disable-triggers',
      '--exclude-table=schema_version',
      '--exclude-table=source_observations',
      home,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    },
  )
  execFileSync(
    join(
      bin,
      'psql',
    ),
    [
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      legacy,
    ],
    {
      input: data,
      encoding: 'utf8',
    },
  )
  const [{ last }] = await sql({
    database: legacy,
    text: 'select max(seq)::integer as last from events where hydra_id = $1',
    values: [hydraId],
  }) as [{ last: number }]
  await bulk({
    database: legacy,
    hydraId,
    type: 'card.observed',
    card: observed,
    count: OBSERVATIONS,
    from: last,
    data: 'json_build_object(\'source\', json_build_object(\'adapter\', \'claude-hooks\', \'objectId\', \'session-1\', \'generation\', n, \'observedAt\', \'2026-11-01T00:00:00.000Z\'))',
  })
  await bulk({
    database: legacy,
    hydraId,
    type: 'chat.message',
    card: '$hydra',
    count: TRANSCRIPT_COPIES,
    from: last + OBSERVATIONS,
    data: 'json_build_object(\'role\', \'assistant\', \'text\', \'a copied transcript line\')',
  })
  await bulk({
    database: legacy,
    hydraId,
    type: 'task.brief',
    card: edited,
    count: KEPT,
    from: last + OBSERVATIONS + TRANSCRIPT_COPIES,
    data: 'json_build_object(\'before\', \'bulk \' || (n - 1), \'after\', \'bulk \' || n)',
  })
  await sql({
    database: legacy,
    text: 'update hydras set seq = (select max(seq) from events where hydra_id = $1) where id = $1',
    values: [hydraId],
  })
  await sql({
    database: 'postgres',
    text: `drop database ${home}`,
  })
  await sql({
    database: 'postgres',
    text: `alter database ${legacy} rename to ${home}`,
  })
}

const count = ({
  hydraId,
  type,
}: {
  hydraId: string
  type: string
}) => Number(rows<{ count: string }>({
  text: 'select count(*) from events where hydra_id = $1 and type = $2',
  values: [
    hydraId,
    type,
  ],
})[0]!.count)

const show = async ({
  hydra,
  key,
}: {
  hydra: Hydra
  key: string
}) => (await hydra.owner({
  args: [
    'task',
    'show',
    key,
  ],
})).task

test(
  'a live-size database from #378 migrates when the server starts: repeats and transcript copies go, every task, update and queue stays, and writes continue',
  async () => {
    const hydra = await pnyx.hydra({ id: 'live' })
    const observed = (await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Watched session',
        '--key',
        'watched',
        '--brief',
        'Follow the outside session',
      ],
    })).card.id as string
    const edited = (await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Busy task',
        '--key',
        'busy',
      ],
    })).card.id as string
    await hydra.owner({
      args: [
        'task',
        'depend',
        'busy',
        '--on',
        'watched',
      ],
    })
    const before = {
      watched: await show({
        hydra,
        key: 'watched',
      }),
      busy: await show({
        hydra,
        key: 'busy',
      }),
    }

    await pnyx.restart({
      whileStopped: () => backToSchema1({
        hydraId: hydra.id,
        observed,
        edited,
      }),
    })

    expect(rows<{ version: number }>({ text: 'select max(version) as version from schema_version' })[0]!.version).toBe(5)
    expect(count({
      hydraId: hydra.id,
      type: 'card.observed',
    })).toBe(0)
    expect(count({
      hydraId: hydra.id,
      type: 'chat.message',
    })).toBe(0)
    expect(count({
      hydraId: hydra.id,
      type: 'task.brief',
    })).toBe(KEPT)
    expect(rows({
      text: 'select card_id, adapter, object_id, generation from source_observations where hydra_id = $1',
      values: [hydra.id],
    })).toEqual([
      {
        card_id: observed,
        adapter: 'claude-hooks',
        object_id: 'session-1',
        generation: OBSERVATIONS,
      },
    ])
    expect(rows({
      text: 'select key from hydra_values where hydra_id = $1 and key = \'queue\'',
      values: [hydra.id],
    })).toHaveLength(1)
    expect(await show({
      hydra,
      key: 'watched',
    })).toEqual(before.watched)
    expect(await show({
      hydra,
      key: 'busy',
    })).toEqual(before.busy)

    const updates = await hydra.owner({
      args: [
        'task',
        'updates',
        'busy',
        '--limit',
        '3',
      ],
    })
    expect(updates.events.map((event: { data: { after: string } }) => event.data.after)).toEqual([
      'bulk 101736',
      'bulk 101735',
      'bulk 101734',
    ])

    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'After the migration',
      ],
    })
    expect(created.event.seq).toBeGreaterThan(OBSERVATIONS + TRANSCRIPT_COPIES + KEPT)
  },
  180_000,
)

test(
  'a database another build\'s schema made is refused by name, and the server starts once it is this build\'s again',
  async () => {
    const database = homeDatabase()
    const foreign = () => sql({
      database,
      text: 'update schema_version set version = 99 where version = 5',
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
      text: 'update schema_version set version = 5 where version = 99',
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

    const cycle = await hydra.ownerRefused({
      args: [
        'task',
        'depend',
        'first',
        '--on',
        'second',
      ],
    })
    expect(cycle.code).toBe('DEPENDENCY_CYCLE')

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
      text: 'select id, title, created_seq, unmet_prerequisites from cards where hydra_id = $1 and key = \'third\'',
      values: [hydra.id],
    })
    expect(third).toEqual([
      {
        id: expect.stringMatching(/^task-/),
        title: 'Third',
        created_seq: expect.any(String),
        unmet_prerequisites: [expect.objectContaining({ title: 'Second' })],
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
    const dependent = await show({
      hydra,
      key: 'third',
    })
    await pnyx.restart()
    expect(await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).toEqual(listed)
    expect(await show({
      hydra,
      key: 'third',
    })).toEqual(dependent)
    expect(dependent.readiness.ready).toBe(false)
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
    expect((await show({
      hydra,
      key: 'odd',
    })).title).toBe('before�after � end')

    await hydra.owner({
      args: [
        'task',
        'rename',
        'odd',
        '--title',
        'Plain again',
      ],
    })
    expect((await show({
      hydra,
      key: 'odd',
    })).title).toBe('Plain again')
  },
)
