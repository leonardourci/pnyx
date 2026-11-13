import { query } from '#store/postgres.ts'

const TABLES = [
  'hydras',
  'hydra_values',
  'events',
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

// Everything Postgres holds for a Hydra, as one string, so a test can check that a refused command wrote nothing.
export function storedHydra({ hydraId }: { hydraId: string }): string {
  return JSON.stringify(query({
    statements: TABLES.map(table => ({
      // Ordered by the whole row as text: json columns have no ordering of their own.
      text: `select * from ${table} as row where ${table === 'hydras' ? 'id' : 'hydra_id'} = $1 order by row::text`,
      values: [hydraId],
    })),
  }))
}

// Makes Postgres refuse every insert of events of this type until the returned release, as a write that fails after
// its work ran would. The refusal reads `Postgres: refused <type>`.
export function refuseEvents({ type }: { type: string }): () => void {
  const name = `refuse_${type.replaceAll(
    /[^a-z]/g,
    '_',
  )}`
  query({
    statements: [
      { text: `create or replace function ${name}() returns trigger language plpgsql as $$ begin raise exception 'refused ${type}'; end $$` },
      { text: `create trigger ${name} before insert on events for each row when (new.type = '${type}') execute function ${name}()` },
    ],
  })

  return () => {
    query({ statements: [{ text: `drop trigger if exists ${name} on events` }] })
  }
}
