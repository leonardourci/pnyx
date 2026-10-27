import {
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { hydraDir } from './home-migration.ts'
import { spoolDir, privateDir } from '../store/storage.ts'

// Writes one hook event to the spool without taking the writer lock. The next
// writer ingests it; the spool is a buffer, never a second writer of the log.
export function spoolWrite({
  hydraId,
  entry,
}: {
  hydraId: string
  entry: {
    id: string
  } & Record<string, unknown>
}): string {
  const dir = spoolDir({ dir: hydraDir({ hydraId }) })
  privateDir({ dir })
  // Millisecond time orders files across processes; hrtime keeps same-millisecond writes apart.
  const name = `${String(Date.now()).padStart(
    15,
    '0',
  )}-${process.hrtime.bigint()}-${entry.id.replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  )}.json`
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${name}`,
  )
  writeFileSync(
    tmp,
    JSON.stringify(entry),
    { mode: 0o600 },
  )
  renameSync(
    tmp,
    join(
      dir,
      name,
    ),
  )

  return join(
    dir,
    name,
  )
}
