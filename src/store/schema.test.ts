import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { schema } from './zero-schema.ts'
import { TASK_KINDS, TASK_STATES, NOTE_KINDS } from '#tasks/model.ts'
import { LINK_KINDS, LINK_STATES } from '#tasks/delivery/model.ts'

const ZERO_TYPES: Record<string, string> = {
  'text': 'string',
  'integer': 'number',
  'bigint': 'number',
  'double precision': 'number',
  'boolean': 'boolean',
  'json': 'json',
}

// What the page must never read.
const SERVER_ONLY = [
  'card_bodies.private',
  'sessions',
  'transactions',
]

// Each check constraint that restates a TypeScript union, with the values it must allow.
const UNIONS = {
  'cards.kind': TASK_KINDS,
  'cards.status': TASK_STATES,
  'declarations.state': TASK_STATES,
  'links.kind': LINK_KINDS,
  'links.state': LINK_STATES,
  'notes.kind': NOTE_KINDS,
}

interface Column {
  type: string
  optional: boolean
}

test(
  'the folded migration applies, and the Zero schema matches its tables, keys and checks',
  async () => {
    assert.ok(
      process.env.PGPORT,
      'run through scripts/verification/test.ts, which starts a throwaway Postgres',
    )
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
      const { rows: columns } = await client.query<{
        table_name: string
        column_name: string
        data_type: string
        is_nullable: 'YES' | 'NO'
      }>(`select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public'`)
      const { rows: keys } = await client.query<{
        table_name: string
        columns: string[]
      }>(`select tc.table_name, array_agg(k.column_name::text order by k.ordinal_position) as columns
        from information_schema.table_constraints tc
        join information_schema.key_column_usage k using (constraint_schema, constraint_name)
        where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'
        group by tc.table_name`)
      const { rows: checks } = await client.query<{
        name: string
        definition: string
      }>(`select conrelid::regclass::text as name, pg_get_constraintdef(oid) as definition from pg_constraint
        where contype = 'c' and connamespace = 'public'::regnamespace`)
      const tables = schema.tables as Record<string, {
        columns: Record<string, {
          type: string
          optional?: boolean
        }>
        primaryKey: readonly string[]
      }>

      const inPostgres: Record<string, Column> = {}
      const inZero: Record<string, Column> = {}

      for (const row of columns) {
        const name = `${row.table_name}.${row.column_name}`
        const hidden = SERVER_ONLY.includes(row.table_name) || SERVER_ONLY.includes(name)

        if (!hidden) {
          inPostgres[name] = {
            type: ZERO_TYPES[row.data_type]!,
            optional: row.is_nullable === 'YES',
          }
        }
      }

      for (const [
        table,
        { columns: zeroColumns },
      ] of Object.entries(tables)) {
        for (const [
          column,
          definition,
        ] of Object.entries(zeroColumns)) {
          inZero[`${table}.${column}`] = {
            type: definition.type,
            optional: definition.optional ?? false,
          }
        }
      }

      assert.deepEqual(
        inZero,
        inPostgres,
      )
      assert.deepEqual(
        Object.fromEntries(Object.entries(tables).map(([
          name,
          table,
        ]) => [
          name,
          [...table.primaryKey],
        ])),
        Object.fromEntries(keys.filter(row => !SERVER_ONLY.includes(row.table_name)).map(row => [
          row.table_name,
          row.columns,
        ])),
      )

      for (const [
        column,
        values,
      ] of Object.entries(UNIONS)) {
        const [
          table,
          name,
        ] = column.split('.')
        const check = checks.find(row => row.name === table && row.definition.includes(`(${name} = ANY`))
        assert.deepEqual(
          [...check?.definition.matchAll(/'([^']+)'::text/g) ?? []].map(match => match[1]).toSorted(),
          [...values].toSorted(),
          column,
        )
      }
    } finally {
      await client.end()
      await admin.query(`drop database ${database}`)
      await admin.end()
    }
  },
)
