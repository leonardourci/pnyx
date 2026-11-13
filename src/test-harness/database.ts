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
