import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { beforeAll, expect, test } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'
import { SCHEMA_VERSION, binaries, sql } from './setup/postgres.ts'
import { parsed, pnyxAxi, rows, startPnyx, type Hydra, type Pnyx } from './setup/pnyx.ts'

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
      watched: await hydra.task({ key: 'watched' }),
      busy: await hydra.task({ key: 'busy' }),
    }

    await pnyx.restart({
      whileStopped: () => backToSchema1({
        hydraId: hydra.id,
        observed,
        edited,
      }),
    })

    expect(rows<{ version: number }>({ text: 'select max(version) as version from schema_version' })[0]!.version).toBe(SCHEMA_VERSION)
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
    expect(await hydra.task({ key: 'watched' })).toEqual(before.watched)
    expect(await hydra.task({ key: 'busy' })).toEqual(before.busy)

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
  'upgrading removes per-card widths while preserving project widths, heights and history',
  async () => {
    const hydra = await pnyx.hydra()
    const task = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Keep my size',
      ],
    })
    const layout = {
      workspace: {
        projectWidths: { ideas: 944 },
        chatCollapsed: true,
      },
      cardHeights: { [task.card.id]: 640 },
    }
    const changed = await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify(layout),
      ],
    })
    await pnyx.restart({
      whileStopped: async () => {
        await closePostgres()
        await sql({
          database: homeDatabase(),
          text: 'update events set data = jsonb_set(data::jsonb, \'{data,after,workspace,cardWidths}\', $3::jsonb)::json where hydra_id = $1 and id = $2',
          values: [
            hydra.id,
            changed.event.id,
            JSON.stringify({ [task.card.id]: 880 }),
          ],
        })
        await sql({
          database: homeDatabase(),
          text: `update hydra_values set value = jsonb_set(value::jsonb, '{workspace,cardWidths}', $2::jsonb)::json
          where hydra_id = $1 and key = 'view';`,
          values: [
            hydra.id,
            JSON.stringify({ [task.card.id]: 880 }),
          ],
        })
        await sql({
          database: homeDatabase(),
          text: 'update schema_version set version = 6 where version > 6',
        })
      },
    })
    const view = (await hydra.owner({
      args: [
        'view',
        'show',
      ],
    })).view
    expect(view.workspace).not.toHaveProperty('cardWidths')
    expect(view.workspace.projectWidths.ideas).toBe(944)
    expect(view.workspace.chatCollapsed).toBe(true)
    expect(view.cardHeights[task.card.id]).toBe(640)
    expect(rows<{ value: { workspace: object } }>({
      text: "select value from hydra_values where hydra_id = $1 and key = 'view'",
      values: [hydra.id],
    })[0]!.value.workspace).not.toHaveProperty('cardWidths')
    const historical = rows<{ data: { data: { after: object } } }>({
      text: 'select data from events where hydra_id = $1 and id = $2',
      values: [
        hydra.id,
        changed.event.id,
      ],
    })[0]!
    expect(historical.data.data.after).toMatchObject({
      ...layout,
      workspace: {
        ...layout.workspace,
        cardWidths: { [task.card.id]: 880 },
      },
    })
    const refused = await hydra.ownerRefused({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { cardWidths: { [task.card.id]: 880 } } }),
      ],
    })
    expect(refused.code).toBe('VALIDATION_ERROR')
  },
)

// The owner's PATH carries Postgres's pg_dump and pg_restore; the test PATH does not.
const dataCheck = ({ path = `${binaries()}:${process.env.PATH}` }: { path?: string } = {}) => pnyxAxi({
  args: [
    'setup',
    'postgres',
    '--check',
  ],
  env: {
    ...process.env,
    PATH: path,
  },
})

const copyLeft = async () => (await sql({
  database: 'postgres',
  text: 'select 1 from pg_database where datname = $1',
  values: [`${homeDatabase()}_upgrade_check`],
})).length > 0

const version = async ({ client }: { client: pg.Client }) => (await client.query<{ version: number }>('select max(version) as version from schema_version')).rows[0]!.version

const tasks = async ({ hydra }: { hydra: Hydra }) => ({
  list: (await hydra.owner({
    args: [
      'task',
      'list',
      '--fields',
      'attention,parent,status,worker,hold,queue',
    ],
  })).tasks,
  waiting: await hydra.task({ key: 'second' }),
})

test(
  'the upgrade check migrates a copy of a schema 5 database the old server still holds, and the server migrates the database itself when it starts, keeping every Hydra\'s tasks',
  async () => {
    const hydras = [
      await pnyx.hydra(),
      await pnyx.hydra(),
    ]

    for (const hydra of hydras) {
      for (const key of [
        'first',
        'second',
      ]) {
        await hydra.owner({
          args: [
            'task',
            'create',
            '--title',
            `${hydra.id} ${key}`,
            '--key',
            key,
          ],
        })
      }

      await hydra.owner({
        args: [
          'task',
          'depend',
          'second',
          '--on',
          'first',
        ],
      })
    }

    const before = await Promise.all(hydras.map(hydra => tasks({ hydra })))

    await pnyx.restart({
      whileStopped: async () => {
        await closePostgres()
        // What schema 5's build left: a page publication without the Hydra's seq.
        await sql({
          database: homeDatabase(),
          text: `alter publication pnyx_page drop table hydras;
            alter publication pnyx_page add table hydras (id, config, summary);
            delete from schema_version;
            insert into schema_version (version) values (5)`,
        })
        const oldServer = new pg.Client({ database: homeDatabase() })
        await oldServer.connect()

        try {
          const check = await dataCheck()
          expect(
            check.status,
            check.stdout,
          ).toBe(0)
          expect(parsed(check)).toMatchObject({
            database: homeDatabase(),
            schema: 5,
            imported: 'none: no Hydra waiting',
          })
          expect(await version({ client: oldServer })).toBe(5)
          expect(await copyLeft()).toBe(false)
        } finally {
          await oldServer.end()
        }
      },
    })

    expect(rows<{ version: number }>({ text: 'select max(version) as version from schema_version' })[0]!.version).toBe(SCHEMA_VERSION)
    expect(rows<{ columns: string[] }>({ text: 'select attnames as columns from pg_publication_tables where pubname = \'pnyx_page\' and tablename = \'hydras\'' })[0]!.columns).toContain('seq')
    expect(await Promise.all(hydras.map(hydra => tasks({ hydra })))).toEqual(before)
  },
  60_000,
)

test(
  'the upgrade check refuses a schema this build cannot migrate, or cannot copy without pg_dump, and leaves the database as it was',
  async () => {
    await pnyx.restart({
      whileStopped: async () => {
        await closePostgres()
        const database = homeDatabase()
        const setVersion = ({ to }: { to: number }) => sql({
          database,
          text: `delete from schema_version; insert into schema_version (version) values (${to})`,
        })
        await setVersion({ to: 3 })

        const untouched = async () => {
          expect(await copyLeft()).toBe(false)
          expect((await sql({
            database,
            text: 'select max(version) as version from schema_version',
          }))[0]!.version).toBe(3)
        }

        const withoutTools = await dataCheck({ path: dirname(process.execPath) })
        expect(withoutTools.status).toBe(1)
        expect(withoutTools.stdout).toContain('pg_dump could not copy the database for the data check')
        await untouched()

        const unmigratable = await dataCheck()
        expect(unmigratable.status).toBe(1)
        expect(unmigratable.stdout).toContain(`a copy of database ${database} at schema 3 did not migrate to schema ${SCHEMA_VERSION}`)
        await untouched()
        await setVersion({ to: SCHEMA_VERSION })
      },
    })
  },
)
