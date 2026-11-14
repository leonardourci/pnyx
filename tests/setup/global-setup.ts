import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { keepFiles } from './keep.ts'
import { startPostgres } from './postgres.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: Record<'PGHOST' | 'PGPORT' | 'PGUSER', string>
    template: string
  }
}

// One Postgres cluster for the whole run, and one database migrated once that every test file copies.
// eslint-disable-next-line pnyx/object-params -- Vitest owns the global setup's signature.
export default async function setup(project: TestProject) {
  const root = realpathSync(mkdtempSync('/tmp/pv-'))
  const postgres = await startPostgres({
    dir: join(
      root,
      'postgres',
    ),
  })
  const home = join(
    root,
    'template',
  )
  mkdirSync(
    home,
    { recursive: true },
  )
  const template = execFileSync(
    process.execPath,
    [
      '--conditions=source',
      join(
        import.meta.dirname,
        'template.ts',
      ),
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PNYX_HOME: home,
        ...postgres.env,
      },
    },
  ).trim()
  project.provide(
    'postgres',
    postgres.env,
  )
  project.provide(
    'template',
    template,
  )

  return () => {
    try {
      postgres.stop()
    } finally {
      keepFiles({
        from: root,
        exclude: ['postgres/data'],
      })
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  }
}
