import { cpSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

// With PNYX_KEEP_TEST_FILES set to a folder, a run's scratch files are copied there before they are deleted,
// so a failure that only shows on CI can be read afterwards. Postgres's data stays out; its log is kept.
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
