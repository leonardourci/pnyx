import { cpSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

// With PNYX_KEEP_TEST_FILES set, a run's scratch files are copied there before deletion, minus Postgres's data, so a CI-only failure can be read.
export function keepFiles({
  from,
  exclude = [],
}: {
  from: string
  exclude?: string[]
}) {
  const target = process.env.PNYX_KEEP_TEST_FILES

  if (!target || !existsSync(from)) {
    return
  }

  mkdirSync(
    target,
    { recursive: true },
  )
  cpSync(
    from,
    join(
      target,
      basename(from),
    ),
    {
      recursive: true,
      // Sockets and pipes cannot be copied; cpSync owns the filter's signature.
      // eslint-disable-next-line pnyx/object-params
      filter: path => !exclude.some(name => path.includes(`/${name}`))
        && (!existsSync(path) || lstatSync(path).isFile() || lstatSync(path).isDirectory()),
    },
  )
}
