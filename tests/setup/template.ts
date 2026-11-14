// Migrates the run's template database through Pnyx's own connection code; the global setup runs it in its own process.
import { closePostgres, homeDatabase, query } from '#store/postgres.ts'

query({
  schema: 'migrate',
  statements: [],
})
await closePostgres()
console.log(homeDatabase())
