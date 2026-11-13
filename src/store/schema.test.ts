import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { schema } from './zero-schema.ts'

const ZERO_TYPES: Record<string, string> = {
  'text': 'string',
  'integer': 'number',
  'bigint': 'number',
  'double precision': 'number',
  'boolean': 'boolean',
  'json': 'json',
}

// The columns the page must never read.
const SERVER_ONLY = [
  'card_bodies.private',
  'sessions.*',
  'transactions.*',
]

test(
  'the folded migration applies, and the Zero schema names its columns with their types and nullability',
  async () => {
    const database = `schema_${randomUUID().replaceAll(
      '-',
      '',
    )}`
    const admin = new pg.Client({ database: 'postgres' })
    await admin.connect()
    await admin.query(`create database ${database}`)
    const client = new pg.Client({ database })
    await client.connect()

    try {
      await client.query(readFileSync(
        new URL(
          './schema.sql',
          import.meta.url,
        ),
        'utf8',
      ))
      const { rows } = await client.query<{
        table_name: string
        column_name: string
        data_type: string
        is_nullable: 'YES' | 'NO'
      }>(`select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public'`)
      const tables = schema.tables as Record<string, {
        columns: Record<string, {
          type: string
          optional?: boolean
        }>
      }>
      const unsynced = rows.flatMap(row => {
        const column = tables[row.table_name]?.columns[row.column_name]

        if (!column) {
          return [tables[row.table_name] ? `${row.table_name}.${row.column_name}` : `${row.table_name}.*`]
        }

        assert.deepEqual(
          {
            type: column.type,
            optional: column.optional ?? false,
          },
          {
            type: ZERO_TYPES[row.data_type],
            optional: row.is_nullable === 'YES',
          },
          `${row.table_name}.${row.column_name}`,
        )

        return []
      })
      assert.deepEqual(
        [...new Set(unsynced)].toSorted(),
        SERVER_ONLY,
      )

      for (const [
        name,
        table,
      ] of Object.entries(tables)) {
        for (const column of Object.keys(table.columns)) {
          assert.ok(
            rows.some(row => row.table_name === name && row.column_name === column),
            `${name}.${column} is in the Zero schema but not in schema.sql`,
          )
        }
      }
    } finally {
      await client.end()
      await admin.query(`drop database ${database}`)
      await admin.end()
    }
  },
)
