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
      // Ordered by the whole row's text: json columns have no ordering operator.
      text: `select * from ${table} stored where ${table === 'hydras' ? 'id' : 'hydra_id'} = $1 order by stored::text`,
      values: [hydraId],
    })),
  }))
}
