import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'
import { SCHEMA_VERSION, binaries, sql } from './setup/postgres.ts'
import { rows, startPnyx, type Pnyx } from './setup/pnyx.ts'

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
