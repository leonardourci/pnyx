import { readFileSync } from 'node:fs'

export const SCHEMA = readFileSync(
  new URL(
    './schema.sql',
    import.meta.url,
  ),
  'utf8',
)

// schema.sql names its own version, so the number has one source.
export const SCHEMA_VERSION = Number(/insert into schema_version \(version\) values \((\d+)\)/.exec(SCHEMA)?.[1])
