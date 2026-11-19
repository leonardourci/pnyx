import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '#projects/git.ts'
import { hydraPool } from '#projects/remove-pool.ts'
import { loadHydra } from '#app/store.ts'

export async function removalWork({ id }: { id: string }): Promise<Record<string, string>> {
  const state = loadHydra({ hydraId: id }).state
  const pool = await hydraPool({ hydraId: id })
  const copies = Object.values(state.cards).flatMap(card => card.copy && card.copy.state !== 'removed' ? [card.copy.path] : [])
  const paths = new Set([
    ...copies,
    ...pool.slots.map(slot => slot.path),
  ])
  const work: Record<string, string> = {}

  for (const path of paths) {
    if (!existsSync(path)) {
      continue
    }

    work[path] = await copyFingerprint({ path })
  }

  return work
}

async function copyFingerprint({ path }: { path: string }): Promise<string> {
  if (!existsSync(path)) {
    return 'missing'
  }

  const hash = createHash('sha256')
  const listed = await git({
    cwd: path,
    args: [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ],
  })
  const head = await git({
    cwd: path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  hash.update(head.out)
  const branch = await git({
    cwd: path,
    args: [
      'symbolic-ref',
      '-q',
      'HEAD',
    ],
  })
  hash.update(branch.out)
  const index = await git({
    cwd: path,
    args: [
      'diff',
      '--cached',
      '--binary',
    ],
  })
  hash.update(index.out)

  function file({ name }: { name: string }) {
    const full = join(
      path,
      name,
    )
    hash.update(name)
    const stat = lstatSync(
      full,
      { throwIfNoEntry: false },
    )

    if (!stat) {
      hash.update('missing')

      return
    }

    hash.update(String(stat.mode))

    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(full))
    } else if (stat.isFile()) {
      hash.update(readFileSync(full))
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(full).sort()) {
        if (child !== '.git') {
          file({
            name: join(
              name,
              child,
            ),
          })
        }
      }
    }
  }

  if (listed.ok && head.ok) {
    for (const name of [...new Set(listed.out.split('\0').filter(Boolean))].sort()) {
      file({ name })
    }
  } else {
    file({ name: '.' })
  }

  return hash.digest('hex')
}
